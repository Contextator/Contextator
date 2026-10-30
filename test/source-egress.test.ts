import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deprecatedSettingWarnings, EnvSchema, WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { confluenceAllowedHosts, confluenceEgress, EgressRefusedError, sourceEgress } from '../src/services/sources/confluence-egress.js';
import { GitDriver } from '../src/services/sources/git.js';
import { WebDriver } from '../src/services/sources/web.js';
import { fakeResolver, renamed, routeToLoopback } from './support/egress-seams.js';

/**
 * The egress for sources whose host an operator names and which call an API
 * ([ADR-0126](../.ssot/ADR.md#adr-0126) decision 7): one shared list, `SOURCE_ALLOWED_HOSTS`.
 *
 * Same technique as `confluence-egress.test.ts`: a real fixture on the loopback interface, reached by
 * a made-up host that `resolve` answers with a private address, so the guard judges what production would.
 */

const GET = { method: 'GET', headers: {} };
const PRIVATE = '10.20.30.40';

describe('sourceEgress', () => {
  let server: http.Server;
  let hits: string[];
  let base: string;

  beforeEach(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '/');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const refusal = async (promise: Promise<unknown>): Promise<EgressRefusedError> => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressRefusedError);
    return err as EgressRefusedError;
  };

  const seams = (host: string) => ({ resolve: fakeResolver({ [host]: PRIVATE }), route: routeToLoopback(PRIVATE) });

  it('refuses a private host that is not listed, naming both the rule and the host, and sends nothing', async () => {
    const fetch = sourceEgress({ allowedHosts: [], ...seams('minio.corp') });
    const err = await refusal(fetch(renamed(base, 'minio.corp'), GET));
    expect(err.rule).toBe('private');
    expect(err.message).toBe('refused: `minio.corp` resolves to a private address; list `minio.corp` in SOURCE_ALLOWED_HOSTS to allow it');
    expect(hits).toEqual([]);
  });

  it('refuses a private host that only some other host is listed for', async () => {
    const fetch = sourceEgress({ allowedHosts: ['other.corp'], ...seams('minio.corp') });
    const err = await refusal(fetch(renamed(base, 'minio.corp'), GET));
    expect(err.message).toContain('`minio.corp`');
    expect(err.message).toContain('SOURCE_ALLOWED_HOSTS');
    expect(hits).toEqual([]);
  });

  it('reaches a listed private host', async () => {
    const fetch = sourceEgress({ allowedHosts: ['MinIO.Corp.'], ...seams('minio.corp') });
    const response = await fetch(renamed(base, 'minio.corp'), GET);
    expect(response.status).toBe(200);
    expect(hits).toEqual(['/']);
  });

  it('never lifts loopback, whatever the list says', async () => {
    const fetch = sourceEgress({ allowedHosts: ['127.0.0.1'] });
    const err = await refusal(fetch(base, GET));
    expect(err.rule).toBe('loopback');
    expect(hits).toEqual([]);
  });

  it('honours httpsOnly and the non-http scheme refusal, as every egress does', async () => {
    const fetch = sourceEgress({ allowedHosts: ['minio.corp'], httpsOnly: true, ...seams('minio.corp') });
    expect((await refusal(fetch('http://minio.corp/', GET))).message).toContain('only https is allowed');
    expect((await refusal(fetch('ftp://minio.corp/', GET))).message).toContain('the URL is a `ftp:` address');
    expect(hits).toEqual([]);
  });

  it('is the same rule under Confluence’s wording', async () => {
    const fetch = confluenceEgress({ allowedHosts: [], ...seams('wiki.corp') });
    const err = await refusal(fetch(renamed(base, 'wiki.corp'), GET));
    expect(err.message).toBe('refused: `wiki.corp` resolves to a private address; list `wiki.corp` in SOURCE_ALLOWED_HOSTS to allow it');
  });
});

describe('confluenceAllowedHosts', () => {
  it('is the union of the shared and the deprecated list, and empty when neither is set', () => {
    expect(confluenceAllowedHosts({})).toEqual([]);
    expect(confluenceAllowedHosts({ SOURCE_ALLOWED_HOSTS: ['a.corp'] })).toEqual(['a.corp']);
    expect(confluenceAllowedHosts({ CONFLUENCE_ALLOWED_HOSTS: ['b.corp'] })).toEqual(['b.corp']);
    expect(confluenceAllowedHosts({ SOURCE_ALLOWED_HOSTS: ['a.corp'], CONFLUENCE_ALLOWED_HOSTS: ['b.corp'] })).toEqual(['a.corp', 'b.corp']);
  });
});

describe('SOURCE_ALLOWED_HOSTS as configuration', () => {
  const parse = (extra: Record<string, string>) => EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', ...extra });

  it('defaults to allowing no private host', () => {
    const result = parse({});
    expect(result.success && result.data.SOURCE_ALLOWED_HOSTS).toEqual([]);
  });

  it('takes the same comma-separated host list as the other three', () => {
    const result = parse({ SOURCE_ALLOWED_HOSTS: ' MinIO.Corp. , 10.0.4.12,[fd00::1]' });
    expect(result.success && result.data.SOURCE_ALLOWED_HOSTS).toEqual(['minio.corp', '10.0.4.12', 'fd00::1']);
  });

  it.each(['https://minio.corp', 'minio.corp:9000', 'minio.corp/bucket', '*'])('rejects %s rather than silently allowing nothing', (value) => {
    const result = parse({ SOURCE_ALLOWED_HOSTS: value });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('without scheme, port or path');
  });

  it('does not admit a host for a web or git source', () => {
    const result = parse({ SOURCE_ALLOWED_HOSTS: 'minio.corp' });
    expect(result.success && result.data.WEB_ALLOWED_HOSTS).toEqual([]);
    expect(result.success && result.data.GIT_ALLOWED_HOSTS).toEqual([]);
    expect(result.success && result.data.CONFLUENCE_ALLOWED_HOSTS).toEqual([]);
  });
});

describe('deprecatedSettingWarnings', () => {
  const parse = (extra: Record<string, string>) => {
    const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://unused/unused', ...extra });
    if (!result.success) throw new Error('config should parse');
    return result.data;
  };

  it('says nothing while CONFLUENCE_ALLOWED_HOSTS is unset', () => {
    expect(deprecatedSettingWarnings(parse({}))).toEqual([]);
    expect(deprecatedSettingWarnings(parse({ SOURCE_ALLOWED_HOSTS: 'minio.corp' }))).toEqual([]);
  });

  it('warns once, naming the replacement, when CONFLUENCE_ALLOWED_HOSTS is non-empty', () => {
    const warnings = deprecatedSettingWarnings(parse({ CONFLUENCE_ALLOWED_HOSTS: 'wiki.corp' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CONFLUENCE_ALLOWED_HOSTS is deprecated');
    expect(warnings[0]).toContain('SOURCE_ALLOWED_HOSTS');
    expect(warnings[0]).toContain('no earlier than 1.0.0');
  });

  it('warns also when both lists are set', () => {
    expect(deprecatedSettingWarnings(parse({ CONFLUENCE_ALLOWED_HOSTS: 'wiki.corp', SOURCE_ALLOWED_HOSTS: 'minio.corp' }))).toHaveLength(1);
  });
});

// ADR-0126 decision 7: "A host listed in SOURCE_ALLOWED_HOSTS is not admitted for a web or git source."
// Asserted on the drivers themselves, so a later phase that hands a web or git egress the shared list fails here.
describe('SOURCE_ALLOWED_HOSTS does not admit a host for a web or git source', () => {
  const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
  const KEY = 'k'.repeat(64);
  const shared = { SOURCE_ALLOWED_HOSTS: ['docs.corp', 'git.corp', '10.0.0.1'], CONFLUENCE_ALLOWED_HOSTS: ['docs.corp', 'git.corp'] };
  const ids = { id: '00000000-0000-4000-8000-000000000051', projectId: '00000000-0000-4000-8000-000000000052', name: 'guarded' };

  it('refuses a web source on a listed private host, naming WEB_ALLOWED_HOSTS, and connects to nothing', async () => {
    const row = {
      ...ids,
      type: 'web',
      config: { entryUrl: 'http://docs.corp/sitemap.xml', extensions: ['html'] },
      secretEnc: null,
    } as unknown as DocumentSourceRow;
    const config = { ...WEB_LIMIT_DEFAULTS, DATA_DIR: '/nonexistent', SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [], ...shared };
    // The route would deliver to a closed loopback port: reaching it at all would be an ECONNREFUSED, not a refusal.
    const driver = new WebDriver(row, { db: null as never, log, config }, undefined, {
      resolve: fakeResolver({ 'docs.corp': PRIVATE }),
      route: routeToLoopback(PRIVATE),
    });
    const err = await driver.test().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('refused:');
    expect(err?.message).toContain('`docs.corp` resolves to a private address');
    expect(err?.message).toContain('WEB_ALLOWED_HOSTS');
    expect(err?.message).not.toContain('SOURCE_ALLOWED_HOSTS');
  });

  it('refuses a git source on a listed private host, naming GIT_ALLOWED_HOSTS', async () => {
    const row = {
      ...ids,
      type: 'git',
      config: { url: 'http://10.0.0.1/group/docs.git', branch: 'main', provider: 'github' },
      secretEnc: null,
    } as unknown as DocumentSourceRow;
    const config = { ...WEB_LIMIT_DEFAULTS, DATA_DIR: '/nonexistent', SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [], ...shared };
    const err = await new GitDriver(row, { db: null as never, log, config }).test().then(
      () => null,
      (e: unknown) => e as EgressRefusedError,
    );
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect(err?.rule).toBe('private');
    expect(err?.message).toContain('GIT_ALLOWED_HOSTS');
    expect(err?.message).not.toContain('SOURCE_ALLOWED_HOSTS');
  });
});
