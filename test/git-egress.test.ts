import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvSchema, GIT_MAX_PACK_BYTES_DEFAULT, WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { confluenceEgress, EgressRefusedError, gitEgress, webEgress } from '../src/services/sources/confluence-egress.js';
import { GitDriver } from '../src/services/sources/git.js';
import { GitResponseTooLargeError, guardedGitHttp } from '../src/services/sources/git-http.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, publicFixture, renamed, routeToLoopback } from './support/egress-seams.js';

/**
 * The git source goes through the same egress guard as the web source (ADR-0088, ADR-0107): every request
 * isomorphic-git makes — the ref advertisement, the pack request, each redirect hop — is judged by the
 * address the name resolved to, and a refused one sends nothing. Fixtures are smart-HTTP stubs on
 * 127.0.0.1 reached through the `resolve` / `route` seams; **the guard is not relaxed**. No request leaves
 * the loopback interface.
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const KEY = 'k'.repeat(64);
const TOKEN = 'ghp-not-a-real-token';
const OID = 'b'.repeat(40);
const HOST = 'git.fixture.example';
const OTHER = 'mirror.fixture.example';

/** One pkt-line: four hex digits of length (including themselves), then the payload. */
const pkt = (line: string): string => (line.length + 4).toString(16).padStart(4, '0') + line;
const ADVERTISEMENT = `${pkt('# service=git-upload-pack\n')}0000${pkt(`${OID} refs/heads/main\0side-band-64k\n`)}0000`;

interface Seen {
  url: string;
  authorization: string;
}

interface Stub {
  server: http.Server;
  base: string;
  seen: Seen[];
}

async function listen(handler: http.RequestListener): Promise<Stub> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization ?? '' });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (stub: Stub): Promise<void> => new Promise((resolve) => stub.server.close(() => resolve()));

const advertise: http.RequestListener = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' }).end(ADVERTISEMENT);
};

const ROW = {
  id: '00000000-0000-4000-8000-000000000041',
  projectId: '00000000-0000-4000-8000-000000000040',
  type: 'git',
  name: 'docs',
};

function driver(
  url: string,
  options: {
    allowed?: string[];
    maxPackBytes?: number;
    egress?: ConstructorParameters<typeof GitDriver>[2];
    dataDir?: string;
    secret?: boolean;
    lastCommit?: string;
  } = {},
): GitDriver {
  return new GitDriver(
    {
      ...ROW,
      config: { url, branch: 'main', provider: 'github', ...(options.lastCommit ? { lastCommit: options.lastCommit } : {}) },
      secretEnc: options.secret ? encryptSecret(TOKEN, { current: KEY }) : null,
    } as unknown as DocumentSourceRow,
    {
      db: null as never,
      log,
      config: {
        ...WEB_LIMIT_DEFAULTS,
        DATA_DIR: options.dataDir ?? '/nonexistent',
        SECRET_KEY: KEY,
        ALLOWED_DOC_ROOTS: [],
        IGNORE_GLOBS: [],
        GIT_ALLOWED_HOSTS: options.allowed ?? [],
        ...(options.maxPackBytes === undefined ? {} : { GIT_MAX_PACK_BYTES: options.maxPackBytes }),
      },
    },
    options.egress,
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject');
}

describe('git remote on an internal address', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await listen(advertise);
  });

  afterEach(async () => {
    await close(stub);
  });

  it('refuses the cloud metadata address, and test() and probe() both say so', async () => {
    const d = driver('http://169.254.169.254/latest/meta-data.git');
    const err = await rejection(d.test());
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as EgressRefusedError).rule).toBe('link-local');
    expect(err.message).toContain('169.254.169.254');
    expect(await rejection(d.probe())).toBeInstanceOf(EgressRefusedError);
  });

  it('refuses loopback and sends nothing to it', async () => {
    const err = await rejection(driver(`${stub.base}/group/docs.git`).test());
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as EgressRefusedError).rule).toBe('loopback');
    expect(stub.seen).toEqual([]);
  });

  it('refuses a private address until GIT_ALLOWED_HOSTS lists it, and names the setting', async () => {
    const err = await rejection(driver('http://10.0.0.1/group/docs.git').test());
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as EgressRefusedError).rule).toBe('private');
    expect(err.message).toContain('GIT_ALLOWED_HOSTS');
    expect(err.message).not.toContain('WEB_ALLOWED_HOSTS');
  });

  it('refuses a clone as well', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-egress-'));
    try {
      const err = await rejection(driver('http://169.254.169.254/x.git', { dataDir }).sync());
      expect(err).toBeInstanceOf(EgressRefusedError);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('git remote that redirects', () => {
  let origin: Stub;
  let internal: Stub;

  beforeEach(async () => {
    internal = await listen(advertise);
    origin = await listen((_req, res) => {
      res.writeHead(302, { Location: `${internal.base}/group/docs.git/info/refs?service=git-upload-pack` }).end();
    });
  });

  afterEach(async () => {
    await close(origin);
    await close(internal);
  });

  it('stops at the first hop when a public host redirects to loopback', async () => {
    const err = await rejection(driver(`${renamed(origin.base, HOST)}/group/docs.git`, { egress: publicFixture(HOST) }).test());
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as EgressRefusedError).rule).toBe('loopback');
    expect(origin.seen).toHaveLength(1);
    expect(internal.seen).toEqual([]);
  });

  it('stops at the first hop when a public host redirects to the metadata address', async () => {
    const redirecting = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    try {
      const err = await rejection(driver(`${renamed(redirecting.base, HOST)}/group/docs.git`, { egress: publicFixture(HOST) }).test());
      expect(err).toBeInstanceOf(EgressRefusedError);
      expect((err as EgressRefusedError).rule).toBe('link-local');
      expect(redirecting.seen).toHaveLength(1);
    } finally {
      await close(redirecting);
    }
  });

  it('gives up after five hops', async () => {
    const loop = await listen((_req, res) => {
      res.writeHead(302, { Location: `${renamed(loop.base, HOST)}/again` }).end();
    });
    try {
      const err = await rejection(driver(`${renamed(loop.base, HOST)}/group/docs.git`, { egress: publicFixture(HOST) }).test());
      expect(err.message).toMatch(/redirect/i);
      expect(loop.seen.length).toBeLessThanOrEqual(6);
    } finally {
      await close(loop);
    }
  });
});

describe('GIT_ALLOWED_HOSTS', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await listen(advertise);
  });

  afterEach(async () => {
    await close(stub);
  });

  const at = (address: string) => ({ resolve: fakeResolver({ [HOST]: address }), route: routeToLoopback(address) });

  it('opens a private host that is listed, and only that host', async () => {
    const url = `${renamed(stub.base, HOST)}/group/docs.git`;
    const unlisted = await rejection(driver(url, { egress: at('10.0.0.5') }).test());
    expect(unlisted).toBeInstanceOf(EgressRefusedError);
    expect((unlisted as EgressRefusedError).rule).toBe('private');

    await expect(driver(url, { egress: at('10.0.0.5'), allowed: [HOST] }).test()).resolves.toBe(`Connected: main is at ${OID.slice(0, 7)}`);
    expect((await rejection(driver(url, { egress: at('10.0.0.5'), allowed: ['other.example'] }).test())) as EgressRefusedError).toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it('opens the RFC 6598 and benchmarking ranges the same way, which are private and not a separate case', async () => {
    const url = `${renamed(stub.base, HOST)}/group/docs.git`;
    for (const address of ['100.64.0.9', '198.18.0.9', 'fd00::9']) {
      expect(((await rejection(driver(url, { egress: at(address) }).test())) as EgressRefusedError).rule).toBe('private');
      await expect(driver(url, { egress: at(address), allowed: [HOST] }).test()).resolves.toContain('Connected');
    }
  });

  it('does not open 240.0.0.0/4, loopback or link-local, listed or not', async () => {
    const url = `${renamed(stub.base, HOST)}/group/docs.git`;
    const cases: Array<[string, string]> = [
      ['240.0.0.1', 'reserved'],
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'link-local'],
    ];
    for (const [address, rule] of cases) {
      const err = await rejection(driver(url, { egress: at(address), allowed: [HOST] }).test());
      expect(err).toBeInstanceOf(EgressRefusedError);
      expect((err as EgressRefusedError).rule).toBe(rule);
    }
    expect(stub.seen).toEqual([]);
  });

  it('does not open the address written into the URL for a name that is not listed', async () => {
    const err = await rejection(driver('http://240.0.0.1/group/docs.git', { allowed: ['240.0.0.1'] }).test());
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect((err as EgressRefusedError).rule).toBe('reserved');
  });
});

describe('GIT_ALLOWED_HOSTS as configuration', () => {
  const parse = (value?: string) =>
    EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', ...(value === undefined ? {} : { GIT_ALLOWED_HOSTS: value }) });

  it('is empty when unset', () => {
    const result = parse();
    expect(result.success && result.data.GIT_ALLOWED_HOSTS).toEqual([]);
  });

  it('takes the same comma-separated host list as WEB_ALLOWED_HOSTS', () => {
    const result = parse('git.corp.example, 10.0.4.12,fd00::1');
    expect(result.success && result.data.GIT_ALLOWED_HOSTS).toEqual(['git.corp.example', '10.0.4.12', 'fd00::1']);
  });

  it('refuses a URL where a host belongs', () => {
    expect(parse('https://git.corp.example/').success).toBe(false);
  });

  it('is independent of the web and Confluence lists', () => {
    const result = EnvSchema.safeParse({
      DATABASE_URL: 'postgres://unused/unused',
      WEB_ALLOWED_HOSTS: 'docs.corp',
      CONFLUENCE_ALLOWED_HOSTS: 'wiki.corp',
    });
    expect(result.success && result.data.GIT_ALLOWED_HOSTS).toEqual([]);
  });
});

describe('credentials', () => {
  let origin: Stub;
  let mirror: Stub;

  beforeEach(async () => {
    mirror = await listen(advertise);
    origin = await listen((req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end();
        return;
      }
      res.writeHead(302, { Location: `${renamed(mirror.base, OTHER)}/group/docs.git/info/refs?service=git-upload-pack` }).end();
    });
  });

  afterEach(async () => {
    await close(origin);
    await close(mirror);
  });

  it('does not follow a redirect to another host', async () => {
    const egress = {
      resolve: fakeResolver({ [HOST]: PUBLIC_FIXTURE_ADDRESS, [OTHER]: PUBLIC_FIXTURE_ADDRESS }),
      route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
    };
    const d = driver(`${renamed(origin.base, HOST)}/group/docs.git`, { egress, secret: true });
    await expect(d.test()).resolves.toContain('Connected');
    // The origin was asked first without a credential, refused, and asked again with one...
    expect(origin.seen.map((s) => s.authorization !== '')).toEqual([false, true]);
    // ...and the host it sent us on never saw it.
    expect(mirror.seen).toHaveLength(1);
    expect(mirror.seen[0]?.authorization).toBe('');
  });
});

describe('a real clone through the guard', () => {
  let work: string;
  let remote: Stub;
  let packRequests: number;

  /** Runs `git upload-pack` as the smart-HTTP server would, so the pack request is a genuine one. */
  const upload =
    (bare: string): http.RequestListener =>
    (req, res) => {
      const env = { ...process.env, GIT_PROTOCOL: String(req.headers['git-protocol'] ?? '') };
      if (req.method === 'GET') {
        const out = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare], { env });
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        res.end(env.GIT_PROTOCOL.includes('version=2') ? out : Buffer.concat([Buffer.from(pkt('# service=git-upload-pack\n') + '0000'), out]));
        return;
      }
      packRequests += 1;
      const child = spawn('git', ['upload-pack', '--stateless-rpc', bare], { env });
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      req.pipe(child.stdin);
      child.stdout.pipe(res);
    };

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-egress-clone-'));
    const src = path.join(work, 'src');
    const bare = path.join(work, 'remote.git');
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.test',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.test',
        },
      });
    fs.mkdirSync(src);
    run(src, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'guide.md'), '# Guide\n');
    // Not compressible, so the pack is bigger than one socket read and arrives in several chunks.
    fs.writeFileSync(path.join(src, 'blob.bin'), Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 2654435761) >>> 24)));
    run(src, 'add', '.');
    run(src, 'commit', '-q', '-m', 'init');
    run(work, 'clone', '-q', '--bare', src, bare);
    packRequests = 0;
    remote = await listen(upload(bare));
  });

  afterAll(async () => {
    await close(remote);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('clones, then updates a checkout, with every request going through the guard', async () => {
    const url = `${renamed(remote.base, HOST)}/remote.git`;
    const dataDir = path.join(work, 'data');
    const first = driver(url, { egress: publicFixture(HOST), dataDir });
    const result = await first.sync();
    expect(result.note).toMatch(/^cloned at /);
    expect(packRequests).toBeGreaterThan(0);
    const docs = await first.docRoot();
    expect(fs.readFileSync(path.join(docs, 'guide.md'), 'utf8')).toBe('# Guide\n');
    expect(fs.statSync(path.join(docs, 'blob.bin')).size).toBe(300_000);

    const head = String(result.configPatch?.lastCommit);
    const again = await driver(url, { egress: publicFixture(HOST), dataDir, lastCommit: head }).sync();
    expect(again.note).toBe(`already at ${head.slice(0, 7)}`);
  });

  it('keeps the checkout it has when an update is refused, rather than re-cloning over it', async () => {
    // Its own checkout, so the test does not lean on the one the test above leaves behind.
    const dataDir = path.join(work, 'data-kept');
    const url = `${renamed(remote.base, HOST)}/remote.git`;
    const checkout = driver(url, { egress: publicFixture(HOST), dataDir });
    const cloned = await checkout.sync();
    const root = await checkout.docRoot();
    expect(fs.existsSync(path.join(root, 'guide.md'))).toBe(true);

    // The same source id, now pointed at an address the guard refuses.
    const refused = driver('http://169.254.169.254/remote.git', { dataDir, lastCommit: String(cloned.configPatch?.lastCommit) });
    expect(await rejection(refused.sync())).toBeInstanceOf(EgressRefusedError);
    expect(fs.existsSync(path.join(root, 'guide.md'))).toBe(true);
  });

  it('stops a clone whose pack is over GIT_MAX_PACK_BYTES, and the error names the setting', async () => {
    const dataDir = path.join(work, 'data-capped');
    const packsBefore = packRequests;
    // The pack deflates to roughly 9 kB while the ref advertisement is a few hundred bytes, so a 4 kB ceiling
    // lets the advertisement through and cuts the pack. (The limit is set directly; the schema's floor is 1 MiB.)
    const err = await rejection(
      driver(`${renamed(remote.base, HOST)}/remote.git`, { egress: publicFixture(HOST), dataDir, maxPackBytes: 4000 }).sync(),
    );
    expect(err).toBeInstanceOf(GitResponseTooLargeError);
    expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    expect(err.message).toContain('4000');
    // The pack request was made, so it is the pack that was cut and not the advertisement before it.
    expect(packRequests).toBeGreaterThan(packsBefore);
  });

  it('keeps the checkout it has when the remote answers over GIT_MAX_PACK_BYTES, rather than re-cloning over it', async () => {
    const dataDir = path.join(work, 'data-kept-capped');
    const url = `${renamed(remote.base, HOST)}/remote.git`;
    const checkout = driver(url, { egress: publicFixture(HOST), dataDir });
    const cloned = await checkout.sync();
    const root = await checkout.docRoot();
    expect(fs.existsSync(path.join(root, 'guide.md'))).toBe(true);

    // The same source id and commit, now under a ceiling the remote's very first answer passes. A fetch
    // that fails this way must not fall back to a clone, which would delete the copy and hit the same wall.
    const small = driver(url, {
      egress: publicFixture(HOST),
      dataDir,
      maxPackBytes: 100,
      lastCommit: String(cloned.configPatch?.lastCommit),
    });
    const err = await rejection(small.sync());
    expect(err).toBeInstanceOf(GitResponseTooLargeError);
    expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    expect(fs.readFileSync(path.join(root, 'guide.md'), 'utf8')).toBe('# Guide\n');
  });

  it('clones when the pack is under GIT_MAX_PACK_BYTES', async () => {
    const dataDir = path.join(work, 'data-roomy');
    const result = await driver(`${renamed(remote.base, HOST)}/remote.git`, {
      egress: publicFixture(HOST),
      dataDir,
      maxPackBytes: 10_000_000,
    }).sync();
    expect(result.note).toMatch(/^cloned at /);
  });
});

describe('GIT_MAX_PACK_BYTES', () => {
  const ok = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
    ({ url: 'http://git.fixture.example/x', status: 200, statusText: 'OK', headers: new Headers(headers), body }) as unknown as Response;

  /** A body of `chunks` chunks of `size` bytes that records whether the reader cancelled it. */
  function stream(chunks: number, size: number) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled >= chunks) return controller.close();
          state.pulled += 1;
          controller.enqueue(new Uint8Array(size));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, state };
  }

  async function drain(it: AsyncIterableIterator<Uint8Array>): Promise<number> {
    let total = 0;
    for await (const part of it) total += part.byteLength;
    return total;
  }

  it('cuts a body that crosses the limit, cancels the reader and names the setting and the value', async () => {
    const { body, state } = stream(50, 1000);
    const client = guardedGitHttp(async () => ok(body), 10_000);
    const res = await client.request({ url: 'http://git.fixture.example/x' });
    const err = await rejection(drain(res.body!));
    expect(err).toBeInstanceOf(GitResponseTooLargeError);
    expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    expect(err.message).toContain('10000');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(50);
  });

  it('lets a body of exactly the limit through', async () => {
    const { body } = stream(10, 1000);
    const res = await guardedGitHttp(async () => ok(body), 10_000).request({ url: 'http://git.fixture.example/x' });
    expect(await drain(res.body!)).toBe(10_000);
  });

  it('refuses a Content-Length over the limit without reading the body', async () => {
    const { body, state } = stream(50, 1000);
    const client = guardedGitHttp(async () => ok(body, { 'content-length': '50000' }), 10_000);
    const err = await rejection(client.request({ url: 'http://git.fixture.example/x' }));
    expect(err).toBeInstanceOf(GitResponseTooLargeError);
    expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it('does not trust a Content-Length that is under the limit', async () => {
    const { body, state } = stream(50, 1000);
    const res = await guardedGitHttp(async () => ok(body, { 'content-length': '10' }), 10_000).request({ url: 'http://git.fixture.example/x' });
    expect(await rejection(drain(res.body!))).toBeInstanceOf(GitResponseTooLargeError);
    expect(state.cancelled).toBe(true);
  });

  it('refuses a real response whose Content-Length is over the limit, through the driver', async () => {
    const big = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Content-Length': '2000000' });
      res.write(Buffer.alloc(1000));
    });
    try {
      const err = await rejection(
        driver(`${renamed(big.base, HOST)}/group/docs.git`, { egress: publicFixture(HOST), maxPackBytes: 1_048_576 }).test(),
      );
      expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    } finally {
      big.server.closeAllConnections();
      await close(big);
    }
  });

  describe('when the ref advertisement itself is over the limit', () => {
    // isomorphic-git's pkt-line reader swallows a failed body read and treats it as the end of the stream, and
    // the advertisement parsers never look at the error it stored. No Content-Length is sent (the response is
    // chunked), so the cut happens mid-read: the guard has to report it itself.
    const LIMIT = 4000;
    const refs = Array.from({ length: 400 }, (_, i) => pkt(`${OID} refs/heads/topic-${i}\n`)).join('');
    // `main` comes first, so a parser fed only the first LIMIT bytes sees the branch it wants and would succeed.
    const HUGE = `${pkt('# service=git-upload-pack\n')}0000${pkt(`${OID} refs/heads/main\0side-band-64k\n`)}${refs}0000`;
    let big: Stub;

    beforeEach(async () => {
      big = await listen((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        res.write(HUGE.slice(0, 2000));
        setTimeout(() => res.end(HUGE.slice(2000)), 10);
      });
    });

    afterEach(async () => {
      big.server.closeAllConnections();
      await close(big);
    });

    const capped = (dataDir?: string) =>
      driver(`${renamed(big.base, HOST)}/group/docs.git`, { egress: publicFixture(HOST), maxPackBytes: LIMIT, ...(dataDir ? { dataDir } : {}) });

    it('fails Test with an error that names the setting, not "branch not found"', async () => {
      expect(HUGE.length).toBeGreaterThan(LIMIT);
      const err = await rejection(capped().test());
      expect(err).toBeInstanceOf(GitResponseTooLargeError);
      expect(err.message).toContain('GIT_MAX_PACK_BYTES');
      expect(err.message).toContain(String(LIMIT));
    });

    it('fails probe() the same way instead of answering null', async () => {
      const err = await rejection(capped().probe());
      expect(err).toBeInstanceOf(GitResponseTooLargeError);
      expect(err.message).toContain('GIT_MAX_PACK_BYTES');
    });

    it('fails a sync with an error that names the setting', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-egress-advert-'));
      try {
        const err = await rejection(capped(dataDir).sync());
        expect(err).toBeInstanceOf(GitResponseTooLargeError);
        expect(err.message).toContain('GIT_MAX_PACK_BYTES');
        expect(err.message).toContain(String(LIMIT));
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe('as configuration', () => {
    const parse = (value?: string) =>
      EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', ...(value === undefined ? {} : { GIT_MAX_PACK_BYTES: value }) });

    it('is 256 MiB when unset', () => {
      const result = parse();
      expect(result.success && result.data.GIT_MAX_PACK_BYTES).toBe(268_435_456);
      expect(GIT_MAX_PACK_BYTES_DEFAULT).toBe(268_435_456);
    });

    it('takes a number of bytes, 1 MiB at the least', () => {
      const result = parse('1048576');
      expect(result.success && result.data.GIT_MAX_PACK_BYTES).toBe(1_048_576);
      expect(parse('1048575').success).toBe(false);
      expect(parse('0').success).toBe(false);
      expect(parse('lots').success).toBe(false);
      expect(parse('1500000.5').success).toBe(false);
    });
  });
});

describe('POST through the guard', () => {
  interface Received {
    method: string;
    url: string;
    body: string;
    contentType: string;
  }

  let target: Stub;
  let received: Received[];
  let redirector: Stub;
  let status: number;

  const capture = (): http.RequestListener => (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.writeHead(200).end('done');
    });
  };

  beforeEach(async () => {
    received = [];
    target = await listen(capture());
    redirector = await listen((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(status, { Location: `${renamed(target.base, OTHER)}/landed` }).end());
    });
  });

  afterEach(async () => {
    await close(target);
    await close(redirector);
  });

  const egress = () =>
    gitEgress({
      allowedHosts: [],
      resolve: fakeResolver({ [HOST]: PUBLIC_FIXTURE_ADDRESS, [OTHER]: PUBLIC_FIXTURE_ADDRESS }),
      route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
    });
  const post = (url: string) =>
    egress()(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: new TextEncoder().encode('0032want abc\n'),
    });

  for (const code of [307, 308]) {
    it(`sends the same body again after a ${code}`, async () => {
      status = code;
      const res = await post(`${renamed(redirector.base, HOST)}/git-upload-pack`);
      expect(res.status).toBe(200);
      expect(received).toEqual([{ method: 'POST', url: '/landed', body: '0032want abc\n', contentType: 'application/x-git-upload-pack-request' }]);
    });
  }

  for (const code of [301, 302, 303]) {
    it(`turns into a GET without the body after a ${code}`, async () => {
      status = code;
      const res = await post(`${renamed(redirector.base, HOST)}/git-upload-pack`);
      expect(res.status).toBe(200);
      expect(received).toEqual([{ method: 'GET', url: '/landed', body: '', contentType: '' }]);
    });
  }

  it('is refused by the web and Confluence egress, which only read', async () => {
    const options = { allowedHosts: [], resolve: fakeResolver({ [HOST]: PUBLIC_FIXTURE_ADDRESS }), route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS) };
    const init = { method: 'POST', headers: {}, body: new TextEncoder().encode('x') };
    const url = `${renamed(target.base, HOST)}/x`;
    await expect(webEgress(options)(url, init)).rejects.toThrow(/GET only/);
    await expect(confluenceEgress(options)(url, init)).rejects.toThrow(/GET only/);
    expect(received).toEqual([]);
  });
});
