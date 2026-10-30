import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { sha256Hex, signRequest } from '../../../src/services/s3/sigv4.js';

/**
 * A MinIO container for the tests that need a real S3 server, and a counting proxy to put in front of it.
 * Nothing in this file imports vitest.
 *
 * The image is the one `backup-restore.itest.ts` runs its S3 case against — the Chainguard build of upstream
 * MinIO, pinned by the multi-arch index digest — and `CONTEXTATOR_TEST_MINIO_IMAGE` swaps it the same way
 * (any S3-compatible server that takes `server /data` and `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`). The
 * backup test is left alone; if its digest is bumped, bump this one with it.
 */
export const MINIO_IMAGE =
  process.env.CONTEXTATOR_TEST_MINIO_IMAGE || 'cgr.dev/chainguard/minio@sha256:268d68a2a3b6fc65f905a61f84d7eab6345ce6bff14f551e2b028ec31e6a1341';

export const MINIO_USER = 'minio-access-key';
export const MINIO_PASSWORD = 'minio-secret-key-0123456789';
export const MINIO_REGION = 'us-east-1';

export interface MinioFixture {
  /** Where the container's port is reachable from the test process. */
  host: string;
  port: number;
  /** Creates a bucket; the container starts with none. */
  createBucket(bucket: string): Promise<void>;
  putObject(bucket: string, key: string, body: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startMinio(): Promise<MinioFixture> {
  const container: StartedTestContainer = await new GenericContainer(MINIO_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(9000);

  // The test's own client, signing with the product's signer; it is how the fixture changes the bucket
  // between runs, and is not under test.
  async function request(method: string, bucket: string, key: string | null, body?: string): Promise<void> {
    const pathname = `/${bucket}${key === null ? '' : `/${key.split('/').map(encodeURIComponent).join('/')}`}`;
    const payload = body ?? '';
    const headers = signRequest({
      method,
      host: `${host}:${port}`,
      path: pathname,
      query: [],
      payloadHash: sha256Hex(payload),
      region: MINIO_REGION,
      accessKeyId: MINIO_USER,
      secretAccessKey: MINIO_PASSWORD,
      date: new Date(),
    });
    const response = await fetch(`http://${host}:${port}${pathname}`, { method, headers, ...(body === undefined ? {} : { body }) });
    if (!response.ok) throw new Error(`${method} ${pathname} failed: HTTP ${response.status} ${await response.text()}`);
  }

  return {
    host,
    port,
    createBucket: (bucket) => request('PUT', bucket, null),
    putObject: (bucket, key, body) => request('PUT', bucket, key, body),
    deleteObject: (bucket, key) => request('DELETE', bucket, key),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface ProxiedRequest {
  method: string;
  /** `list` is `ListObjectsV2`, `get` is `GetObject`; anything else is `other`. */
  kind: 'list' | 'get' | 'other';
  url: string;
}

export interface CountingProxy {
  port: number;
  requests: ProxiedRequest[];
  count(kind: ProxiedRequest['kind']): number;
  /** Forgets what was counted, so the next assertion starts from zero. */
  reset(): void;
  stop(): Promise<void>;
}

/**
 * A pass-through HTTP proxy on the loopback interface that counts what the source sends to MinIO. The
 * request is forwarded **with the `Host` header it arrived with**, so the signature the driver made for
 * `s3.fixture.test:<proxy port>` still verifies at MinIO; the count is therefore of the real wire traffic.
 */
export async function startCountingProxy(target: { host: string; port: number }): Promise<CountingProxy> {
  const requests: ProxiedRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://unused');
    const kind: ProxiedRequest['kind'] =
      req.method === 'GET' && url.searchParams.get('list-type') === '2'
        ? 'list'
        : req.method === 'GET' && url.pathname.split('/').filter(Boolean).length > 1
          ? 'get'
          : 'other';
    requests.push({ method: req.method ?? '', kind, url: req.url ?? '/' });
    const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    count: (kind) => requests.filter((r) => r.kind === kind).length,
    reset: () => {
      requests.length = 0;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
