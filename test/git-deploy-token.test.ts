import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { GitDriver } from '../src/services/sources/git.js';

/**
 * The HTTPS path ADR-0086 documents instead of SSH, end to end through the driver: a stored token and a
 * typed username reach the remote as HTTP Basic credentials. The remote is a smart-HTTP stub on
 * 127.0.0.1 that answers the ref advertisement only to the credentials it expects, the way GitLab
 * answers only to a deploy token's generated username. **No request leaves the loopback interface.**
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const KEY = 'k'.repeat(64);
const TOKEN = 'gldt-not-a-real-deploy-token';
const DEPLOY_USER = 'gitlab+deploy-token-42';
const OID = 'a'.repeat(40);

/** One pkt-line: four hex digits of length (including themselves), then the payload. */
const pkt = (line: string): string => (line.length + 4).toString(16).padStart(4, '0') + line;

describe('git over HTTPS with a deploy token', () => {
  let server: http.Server;
  let base: string;
  let seen: string[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const header = req.headers.authorization ?? '';
      seen.push(header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '');
      if (header !== `Basic ${Buffer.from(`${DEPLOY_USER}:${TOKEN}`).toString('base64')}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitLab"' }).end();
        return;
      }
      if (!req.url?.startsWith('/group/docs.git/info/refs?service=git-upload-pack')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
      res.end(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${OID} refs/heads/main\0side-band-64k\n`)}0000`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  const driver = (username: string): GitDriver =>
    new GitDriver(
      {
        id: '00000000-0000-4000-8000-000000000031',
        projectId: '00000000-0000-4000-8000-000000000030',
        type: 'git',
        name: 'docs',
        config: { url: `${base}/group/docs.git`, branch: 'main', provider: 'gitlab', username },
        secretEnc: encryptSecret(TOKEN, { current: KEY }),
      } as unknown as DocumentSourceRow,
      {
        db: null as never,
        log,
        config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: '/nonexistent', SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] },
      },
    );

  it('sends the typed deploy-token username with the stored token', async () => {
    await expect(driver(DEPLOY_USER).test()).resolves.toBe(`Connected: main is at ${OID.slice(0, 7)}`);
    expect(seen).toContain(`${DEPLOY_USER}:${TOKEN}`);
  });

  it('falls back to the provider default when no username is typed, which a deploy token refuses', async () => {
    await expect(driver('').test()).rejects.toThrow();
    expect(seen).toContain(`oauth2:${TOKEN}`);
    expect(seen).not.toContain(`${DEPLOY_USER}:${TOKEN}`);
  });
});
