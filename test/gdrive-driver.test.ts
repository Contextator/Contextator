import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { CREDENTIAL_SOURCE_TYPES } from '../src/services/encrypted-fields.js';
import { MetricsRegistry } from '../src/services/metrics.js';
import { EgressRefusedError, sourceEgress } from '../src/services/sources/confluence-egress.js';
import type { DriverContext } from '../src/services/sources/driver.js';
import { GdriveDriver } from '../src/services/sources/gdrive.js';
import {
  clearGdriveTokenCache,
  EXPORT_FORMATS,
  GDRIVE_SECRET,
  GdriveAuthError,
  GdriveRequestError,
  GOOGLE_HOSTS,
  isExportTooLarge,
} from '../src/services/sources/gdrive-client.js';
import { exportedSource } from '../src/services/transfer/export.js';
import { importedSourceConfig } from '../src/services/transfer/import.js';
import { GdriveConfig, GDRIVE_SERVER_KEYS, parseSourceConfig, PROBE_TOKEN_KEY, SOURCE_TYPES } from '../src/services/sources.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, routeToLoopback } from './support/egress-seams.js';
import { DOC, FORM, makeTestKey, SHEET, SHORTCUT, SLIDES, StubDrive, type TestKey } from './support/gdrive-stub.js';

/**
 * The `gdrive` source ([ADR-0127](../.ssot/ADR.md#adr-0127)) against a fake of the two Google hosts on the
 * loopback interface, reached **through** the egress guard and its host pin by made-up names
 * (`test/support/egress-seams.ts`, `test/support/gdrive-stub.ts`). The stub checks the RS256 assertion the way
 * Google does, so the sign-in is asserted together with the calls that depend on it.
 */

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const KEY = 'k'.repeat(64);
const PROJECT_ID = '00000000-0000-4000-8000-000000000071';
const SOURCE_ID = '00000000-0000-4000-8000-000000000072';
const TOKEN_HOST = 'oauth.fixture.test';
const API_HOST = 'drive.fixture.test';

let key: TestKey;
let otherKey: TestKey;
let stub: StubDrive;
let dataDir: string;

beforeAll(() => {
  key = makeTestKey();
  otherKey = makeTestKey();
});

beforeEach(async () => {
  clearGdriveTokenCache();
  stub = new StubDrive(key);
  await stub.start();
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-gdrive-driver-')));
});
afterEach(async () => {
  await stub.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const seams = {
  resolve: fakeResolver({ [TOKEN_HOST]: PUBLIC_FIXTURE_ADDRESS, [API_HOST]: PUBLIC_FIXTURE_ADDRESS }),
  route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
};

const row = (config: Record<string, unknown>, credential: TestKey | null = key): DocumentSourceRow =>
  ({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type: 'gdrive',
    name: 'drive',
    label: '',
    config,
    secretEnc: credential === null ? null : encryptSecret(GDRIVE_SECRET.canonicalize(credential.keyFile), { current: KEY }),
    webhookSecret: null,
    flavor: 'plain',
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    createdAt: new Date(),
  }) as DocumentSourceRow;

const context = (extra: Record<string, unknown> = {}): DriverContext => ({
  db: null as never,
  log,
  config: { ...WEB_LIMIT_DEFAULTS, DATA_DIR: dataDir, SECRET_KEY: KEY, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [], ...extra } as DriverContext['config'],
});

const driver = (config: Record<string, unknown>, extra: Record<string, unknown> = {}, credential: TestKey | null = key, metrics?: MetricsRegistry) =>
  new GdriveDriver(row(config, credential), { ...context(extra), ...(metrics ? { metrics } : {}) }, seams, {
    retryDelayMs: 1,
    endpoints: stub.endpoints(TOKEN_HOST, API_HOST),
  });

const tree = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  await walk(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), '');
  return out.sort();
};
const read = (rel: string): Promise<string> => fs.readFile(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), ...rel.split('/')), 'utf8');

/** The tree most tests start from. */
function handbook() {
  const root = stub.folder('Handbook');
  const guide = stub.add({ name: 'Guide', mimeType: DOC, parent: root.id, content: '# Guide\n\nThe guide.\n' });
  const budget = stub.add({ name: 'Budget', mimeType: SHEET, parent: root.id, content: 'PK-sheet-bytes' });
  const deck = stub.add({ name: 'Deck', mimeType: SLIDES, parent: root.id, content: 'PK-slides-bytes' });
  const readme = stub.add({ name: 'readme.md', parent: root.id, content: '# Readme\n' });
  const manual = stub.add({ name: 'manual.pdf', mimeType: 'application/pdf', parent: root.id, content: '%PDF-1.4 manual' });
  const sub = stub.folder('Sub', root.id);
  const nested = stub.add({ name: 'a.txt', mimeType: 'text/plain', parent: sub.id, content: 'nested text' });
  stub.add({ name: 'Survey', mimeType: FORM, parent: root.id });
  stub.add({ name: 'Link to guide', mimeType: SHORTCUT, parent: root.id });
  stub.add({ name: 'pic.png', mimeType: 'image/png', parent: root.id, content: 'png' });
  return { root, guide, budget, deck, readme, manual, sub, nested };
}

describe('the gdrive credential document', () => {
  it('is the key file reduced to three fields, in a fixed order, with token_uri and the rest dropped', () => {
    const stored = JSON.parse(GDRIVE_SECRET.canonicalize(key.keyFile)) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['v', 'clientEmail', 'privateKeyId', 'privateKey']);
    expect(stored).toMatchObject({ v: 1, clientEmail: key.clientEmail, privateKeyId: key.privateKeyId });
    expect(JSON.stringify(stored)).not.toContain('evil.example.invalid');
    expect(JSON.stringify(stored)).not.toContain('project_id');
    expect(GDRIVE_SECRET.parse(GDRIVE_SECRET.canonicalize(key.keyFile)).clientEmail).toBe(key.clientEmail);
  });

  it('accepts its own stored form again', () => {
    const once = GDRIVE_SECRET.canonicalize(key.keyFile);
    expect(GDRIVE_SECRET.canonicalize(once)).toBe(once);
  });

  it('refuses anything that is not a service account key file, naming the field and never a value', () => {
    const file = JSON.parse(key.keyFile) as Record<string, string>;
    const oauth = JSON.stringify({ ...file, type: 'authorized_user' });
    expect(() => GDRIVE_SECRET.canonicalize(oauth)).toThrow(/service account key file/);
    expect(() => GDRIVE_SECRET.canonicalize(JSON.stringify({ ...file, client_email: '' }))).toThrow(/client_email/);
    const noKey = { ...file } as Record<string, string | undefined>;
    delete noKey.private_key;
    expect(() => GDRIVE_SECRET.canonicalize(JSON.stringify(noKey))).toThrow(/private_key/);
    // A private key that does not open names the field and nothing of what was pasted.
    let message = '';
    try {
      GDRIVE_SECRET.canonicalize(JSON.stringify({ ...file, private_key: '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('privateKey');
    expect(message).not.toContain('bm90IGEga2V5');
    // Not JSON, and JSON that is not an object: no V8 syntax error quoting the text.
    expect(() => GDRIVE_SECRET.canonicalize(`${key.clientEmail} oops`)).toThrow('key file of a Google service account');
    expect(() => GDRIVE_SECRET.canonicalize('[1]')).toThrow('key file of a Google service account');
  });

  it('is on the credential list, and the transfer manifest knows the type', () => {
    expect([...CREDENTIAL_SOURCE_TYPES]).toContain('gdrive');
    expect([...SOURCE_TYPES]).toContain('gdrive');
  });
});

describe('the gdrive settings', () => {
  const parse = (extra: Record<string, unknown>) => parseSourceConfig('gdrive', extra);

  it('needs one to fifty folder ids, drops repeats and takes the default types', () => {
    const id = 'A'.repeat(12);
    expect(() => parse({})).toThrow(/folderIds/);
    expect(() => parse({ folderIds: [] })).toThrow(/at least one folder/);
    expect(() => parse({ folderIds: ['short'] })).toThrow(/folder id/);
    expect(() => parse({ folderIds: ["x'y".padEnd(12, 'z')] })).toThrow(/folder id/);
    expect(() => parse({ folderIds: Array.from({ length: 51 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(10)}`) })).toThrow();
    const cfg = parse({ folderIds: [id, id] });
    expect(cfg.folderIds).toEqual([id]);
    expect(cfg.extensions).toEqual(['md', 'txt', 'pdf', 'docx', 'xlsx', 'pptx']);
  });

  it('keeps the server’s two keys when it is given them, which the services overwrite', () => {
    expect([...GDRIVE_SERVER_KEYS]).toEqual(['serviceAccountEmail', 'changesCursor']);
    expect(GdriveConfig.parse({ folderIds: ['A'.repeat(12)], serviceAccountEmail: 'a@b.c', changesCursor: '12' })).toMatchObject({
      changesCursor: '12',
    });
  });

  it('drops the e-mail and the cursor an archive carries, so an import cannot name whom to share with', () => {
    const id = 'A'.repeat(12);
    const config = importedSourceConfig({
      type: 'gdrive',
      config: { folderIds: [id], serviceAccountEmail: 'attacker@evil.iam.gserviceaccount.com', changesCursor: '42', extensions: ['md'] },
    });
    expect(config).not.toHaveProperty('serviceAccountEmail');
    expect(config).not.toHaveProperty('changesCursor');
    expect(config).toMatchObject({ folderIds: [id], extensions: ['md'] });
  });

  it('leaves the cursor, the e-mail and the probe token out of an export', () => {
    const exported = exportedSource({
      type: 'gdrive',
      name: 'drive',
      label: '',
      flavor: 'plain',
      syncIntervalMinutes: null,
      webhookMinIntervalMinutes: null,
      config: { folderIds: ['A'.repeat(12)], serviceAccountEmail: key.clientEmail, changesCursor: '77', [PROBE_TOKEN_KEY]: '77', extensions: ['md'] },
    } as unknown as DocumentSourceRow);
    expect(exported.config).toEqual({ folderIds: ['A'.repeat(12)], extensions: ['md'] });
  });
});

describe('the first sync', () => {
  it('signs in with a valid assertion, mirrors the tree by path, and exports Docs, Sheets and Slides in their formats', async () => {
    const t = handbook();
    const d = driver({ folderIds: [t.root.id] });
    const result = await d.sync();

    expect(await tree()).toEqual([
      'Handbook/Budget.xlsx',
      'Handbook/Deck.pptx',
      'Handbook/Guide.md',
      'Handbook/Sub/a.txt',
      'Handbook/manual.pdf',
      'Handbook/readme.md',
    ]);
    expect(await read('Handbook/Guide.md')).toBe('# Guide\n\nThe guide.\n');
    expect(await read('Handbook/Budget.xlsx')).toBe('PK-sheet-bytes');
    expect(await read('Handbook/Deck.pptx')).toBe('PK-slides-bytes');
    expect(await read('Handbook/manual.pdf')).toBe('%PDF-1.4 manual');

    // Export formats: Docs → Markdown, Sheets → .xlsx, Slides → .pptx; stored files are downloaded as they are.
    const exports = stub.log.filter((r) => r.kind === 'export').map((r) => r.query.mimeType);
    expect(exports.sort()).toEqual([EXPORT_FORMATS[DOC]?.mimeType, EXPORT_FORMATS[SHEET]?.mimeType, EXPORT_FORMATS[SLIDES]?.mimeType].sort());
    expect(EXPORT_FORMATS[DOC]?.mimeType).toBe('text/markdown');
    expect(stub.count('media')).toBe(3);
    expect(stub.count('token')).toBe(1);

    // The cursor was taken first, and is both the cursor and the probe token.
    const apiKinds = stub.log.filter((r) => r.kind !== 'token').map((r) => r.kind);
    expect(apiKinds[0]).toBe('startPageToken');
    expect(apiKinds.indexOf('startPageToken')).toBeLessThan(apiKinds.indexOf('folder'));
    expect(apiKinds.indexOf('startPageToken')).toBeLessThan(apiKinds.indexOf('list'));
    const cursor = String(stub.changeId);
    expect(result.configPatch).toEqual({ changesCursor: cursor, [PROBE_TOKEN_KEY]: cursor });
    expect(result.note).toContain('6 files, 6 downloaded, 0 unchanged, 0 removed');
    expect(result.note).toContain('2 folder(s) walked');
    expect(result.note).toContain('1 Google file(s) of a type that cannot be exported');
    expect(result.note).toContain('1 shortcut(s) not followed');
    expect(result.note).toContain('1 file(s) left out');
  });

  it('sends the sign-in the way Google expects: the scope, no sub, and nothing to the key file’s own token_uri', async () => {
    const t = handbook();
    await driver({ folderIds: [t.root.id] }).sync();
    // The stub refuses an assertion with a `sub`, a wrong audience or scope, or a bad signature; the run passing is the check.
    expect(stub.log.filter((r) => r.kind === 'token').map((r) => r.host)).toEqual([TOKEN_HOST]);
    expect(stub.log.every((r) => r.host === TOKEN_HOST || r.host === API_HOST)).toBe(true);
    // Shared-drive parameters go where the API takes them, and only there.
    const listing = stub.log.find((r) => r.kind === 'list');
    expect(listing?.query).toMatchObject({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '1000', orderBy: 'name' });
    expect(stub.log.find((r) => r.kind === 'export')?.query).not.toHaveProperty('includeItemsFromAllDrives');
    // Every API call carried a bearer token.
    expect(stub.log.filter((r) => r.kind !== 'token').every((r) => r.authorized)).toBe(true);
  });

  it('reports Test with the account and the folders it can see', async () => {
    const t = handbook();
    const message = await driver({ folderIds: [t.root.id] }).test();
    expect(message).toBe(`Signed in as ${key.clientEmail} — 1 folder(s) shared with it: Handbook`);
  });
});

describe('a later sync', () => {
  it('downloads nothing when nothing changed, and still takes a cursor and lists', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id] };
    await driver(config).sync();
    stub.reset();
    const second = await driver(config).sync();
    expect(second.note).toContain('6 files, 0 downloaded, 6 unchanged, 0 removed');
    expect({ media: stub.count('media'), exports: stub.count('export'), start: stub.count('startPageToken'), token: stub.count('token') }).toEqual({
      media: 0,
      exports: 0,
      start: 1,
      token: 0,
    });
    expect(stub.count('list')).toBe(2);
  });

  it('fetches only the file whose version or checksum moved, and removes the one that was trashed', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id] };
    await driver(config).sync();
    stub.update(t.guide.id, '# Guide\n\nRevised guide.\n');
    stub.update(t.manual.id, '%PDF-1.4 manual, second edition');
    stub.trash(t.nested.id);
    stub.reset();

    const result = await driver(config).sync();
    expect(result.note).toContain('5 files, 2 downloaded, 3 unchanged, 1 removed');
    expect(stub.count('export')).toBe(1);
    expect(stub.count('media')).toBe(1);
    expect(await read('Handbook/Guide.md')).toBe('# Guide\n\nRevised guide.\n');
    expect(await read('Handbook/manual.pdf')).toBe('%PDF-1.4 manual, second edition');
    expect(await tree()).not.toContain('Handbook/Sub/a.txt');
    // The empty folder went with its last file.
    expect(await fs.readdir(path.join(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID), 'Handbook'))).not.toContain('Sub');
    expect(result.configPatch).toEqual({ changesCursor: String(stub.changeId), [PROBE_TOKEN_KEY]: String(stub.changeId) });
  });

  it('treats a rename as a removal and an addition', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id] };
    await driver(config).sync();
    stub.rename(t.readme.id, 'start-here.md');
    const result = await driver(config).sync();
    expect(result.note).toContain('1 downloaded');
    expect(result.note).toContain('1 removed');
    expect(await tree()).toContain('Handbook/start-here.md');
    expect(await tree()).not.toContain('Handbook/readme.md');
  });

  it('keeps the previous tree and moves nothing when a download fails, and recovers on the next run', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id] };
    await driver(config).sync();
    stub.update(t.guide.id, 'new guide');
    stub.failing.add(t.guide.id);
    await expect(driver(config).sync()).rejects.toThrow(/HTTP 500/);
    expect(await read('Handbook/Guide.md')).toBe('# Guide\n\nThe guide.\n');
    expect(await tree()).toHaveLength(6);

    stub.failing.clear();
    const result = await driver(config).sync();
    expect(result.note).toContain('1 downloaded');
    expect(await read('Handbook/Guide.md')).toBe('new guide');
  });
});

describe('the probe', () => {
  it('has nothing to compare before the first sync, and makes no request', async () => {
    const t = handbook();
    expect(await driver({ folderIds: [t.root.id] }).probe()).toBeNull();
    expect(stub.log).toEqual([]);
  });

  it('costs one request when nothing changed, and answers with the cursor the sync stored', async () => {
    const t = handbook();
    const synced = await driver({ folderIds: [t.root.id] }).sync();
    const cursor = synced.configPatch?.changesCursor as string;
    stub.reset();
    const probe = await driver({ folderIds: [t.root.id], changesCursor: cursor }).probe();
    expect(probe).toBe(cursor);
    expect(probe).toBe(synced.configPatch?.[PROBE_TOKEN_KEY]);
    // One changes.list; the token came from the cache of the sync that ran a moment ago.
    expect({ api: stub.apiRequests, changes: stub.count('changes'), token: stub.count('token') }).toEqual({ api: 1, changes: 1, token: 0 });
    expect(stub.log[0]?.query).toMatchObject({ pageToken: cursor, pageSize: '1' });
  });

  it('answers with a different value once anything changed, and never the stored cursor', async () => {
    const t = handbook();
    const synced = await driver({ folderIds: [t.root.id] }).sync();
    const cursor = synced.configPatch?.changesCursor as string;
    stub.update(t.readme.id, '# Readme, edited\n');
    const probe = await driver({ folderIds: [t.root.id], changesCursor: cursor }).probe();
    expect(probe).not.toBe(cursor);
    expect(probe).toMatch(/^changed:/);
    // Two changes: the first page is not the last, and it still says changed.
    stub.update(t.guide.id, 'also edited');
    expect(await driver({ folderIds: [t.root.id], changesCursor: cursor }).probe()).toMatch(/^changed:/);
  });

  it('throws on a cursor Google refuses, so the scheduler runs the source', async () => {
    const t = handbook();
    await expect(driver({ folderIds: [t.root.id], changesCursor: '999999999' }).probe()).rejects.toThrow(/HTTP 400/);
  });

  it('asks for a token at most about once an hour, and at once when Google says it lives under a minute', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id], changesCursor: String(stub.changeId) };
    await driver(config).probe();
    await driver(config).probe();
    await driver(config).probe();
    expect(stub.count('token')).toBe(1);

    clearGdriveTokenCache();
    stub.reset();
    stub.tokenLifetime = 60;
    await driver(config).probe();
    await driver(config).probe();
    expect(stub.count('token')).toBe(2);
  });

  it('does not hand one key’s token to a source that pastes the same e-mail and key id with a key of its own', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id], changesCursor: String(stub.changeId) };
    // Another project's source is running with the real key, so its token is warm.
    await driver(config).probe();
    expect(stub.count('token')).toBe(1);
    // A source built from the two public values and a key it generated must prove itself to Google, and fail there.
    const forged = { ...makeTestKey(key.clientEmail, key.privateKeyId) };
    const err = (await driver(config, {}, forged)
      .probe()
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GdriveAuthError);
    expect(err.message).toContain('invalid_grant');
    expect(stub.count('token')).toBe(2);
    expect(stub.count('changes')).toBe(1);
  });

  it('signs in again, once, when Google has revoked the token it handed out', async () => {
    const t = handbook();
    const config = { folderIds: [t.root.id], changesCursor: String(stub.changeId) };
    await driver(config).probe();
    stub.revokeTokens();
    stub.reset();
    expect(await driver(config).probe()).toBe(config.changesCursor);
    expect(stub.log.map((r) => r.kind)).toEqual(['changes', 'token', 'changes']);
  });
});

describe('what the walk makes of names', () => {
  it('suffixes every sibling that shares a name, and a Doc whose name is another file’s path', async () => {
    const root = stub.folder('Docs');
    const planA = stub.add({ name: 'Plan', mimeType: DOC, parent: root.id, content: 'a' });
    const planB = stub.add({ name: 'Plan', mimeType: DOC, parent: root.id, content: 'b' });
    const docNotes = stub.add({ name: 'notes', mimeType: DOC, parent: root.id, content: 'doc notes' });
    const fileNotes = stub.add({ name: 'notes.md', parent: root.id, content: 'file notes' });
    stub.add({ name: 'Report.md', mimeType: DOC, parent: root.id, content: 'no double extension' });
    stub.add({ name: 'a/b', mimeType: DOC, parent: root.id, content: 'slash' });
    const id8 = (id: string) => id.slice(0, 8);

    await driver({ folderIds: [root.id] }).sync();
    expect(await tree()).toEqual(
      [
        'Docs/Report.md',
        `Docs/Plan (${id8(planA.id)}).md`,
        `Docs/Plan (${id8(planB.id)}).md`,
        `Docs/notes (${id8(docNotes.id)}).md`,
        `Docs/notes (${id8(fileNotes.id)}).md`,
        'Docs/a_b.md',
      ].sort(),
    );
  });

  it('counts a name the clash suffix pushes past 255 bytes, and writes nothing for it', async () => {
    const root = stub.folder('Docs');
    const stem = 'x'.repeat(245);
    stub.add({ name: stem, mimeType: DOC, parent: root.id, content: 'doc' });
    stub.add({ name: `${stem}.md`, parent: root.id, content: 'file' });
    stub.add({ name: 'fine.md', parent: root.id, content: 'fine' });
    const result = await driver({ folderIds: [root.id] }).sync();
    expect(await tree()).toEqual(['Docs/fine.md']);
    expect(result.note).toContain('2 with a name that cannot be a file path');
  });

  it('skips and counts a name that cannot be a path, with everything under a folder of that name', async () => {
    const root = stub.folder('Docs');
    stub.add({ name: 'fine.md', parent: root.id, content: 'fine' });
    const dots = stub.folder('..', root.id);
    stub.add({ name: 'under-dots.md', parent: dots.id, content: 'x' });
    stub.add({ name: '', mimeType: DOC, parent: root.id, content: 'x' });
    stub.add({ name: 'nul\0name.md', parent: root.id, content: 'x' });
    stub.add({ name: `${'x'.repeat(260)}.md`, parent: root.id, content: 'x' });
    stub.add({ name: '.hidden.md', parent: root.id, content: 'x' });

    const result = await driver({ folderIds: [root.id] }).sync();
    expect(await tree()).toEqual(['Docs/fine.md']);
    expect(result.note).toContain('4 with a name that cannot be a file path');
    expect(result.note).toContain('..');
    expect(result.note).toContain('1 file(s) left out');
  });

  it('suffixes two roots that share a name, and walks a folder reached twice once', async () => {
    const one = stub.folder('Shared');
    const two = stub.folder('Shared');
    stub.add({ name: 'one.md', parent: one.id, content: '1' });
    stub.add({ name: 'two.md', parent: two.id, content: '2' });
    const both = stub.folder('Both', one.id);
    both.parents.push(two.id);
    stub.add({ name: 'twice.md', parent: both.id, content: 'twice' });

    await driver({ folderIds: [one.id, two.id] }).sync();
    const prefix = (id: string) => `Shared (${id.slice(0, 8)})`;
    expect(await tree()).toEqual([`${prefix(one.id)}/Both/twice.md`, `${prefix(one.id)}/one.md`, `${prefix(two.id)}/two.md`].sort());
  });
});

describe('the ceiling', () => {
  it('keeps the first files of the walk — roots in the order listed, then by name — and says what it left out', async () => {
    const late = stub.folder('Alpha');
    const first = stub.folder('Zulu');
    stub.add({ name: 'z1.md', parent: first.id, content: 'z1' });
    stub.add({ name: 'z2.md', parent: first.id, content: 'z2' });
    stub.add({ name: 'a1.md', parent: late.id, content: 'a1' });
    stub.reverseListing = true;

    const result = await driver({ folderIds: [first.id, late.id] }, { GDRIVE_MAX_FILES: 2 }).sync();
    expect(await tree()).toEqual(['Zulu/z1.md', 'Zulu/z2.md']);
    expect(result.note).toContain('STOPPED AT THE 2-FILE CEILING (GDRIVE_MAX_FILES)');
    expect(result.note).toContain('NOT indexed');
  });

  it('lists a folder’s children by name and then by id whatever order Google answers in', async () => {
    const root = stub.folder('Docs');
    for (const name of ['c.md', 'a.md', 'b.md']) stub.add({ name, parent: root.id, content: name });
    stub.reverseListing = true;
    await driver({ folderIds: [root.id] }, { GDRIVE_MAX_FILES: 2 }).sync();
    expect(await tree()).toEqual(['Docs/a.md', 'Docs/b.md']);
  });

  it('does not stop a source that is exactly at the ceiling', async () => {
    const root = stub.folder('Docs');
    stub.add({ name: 'a.md', parent: root.id, content: 'a' });
    stub.add({ name: 'b.md', parent: root.id, content: 'b' });
    const result = await driver({ folderIds: [root.id] }, { GDRIVE_MAX_FILES: 2 }).sync();
    expect(result.note).not.toContain('CEILING');
  });
});

describe('size', () => {
  it('refuses an export Google will not produce by name, keeps the rest and moves the cursor', async () => {
    const root = stub.folder('Docs');
    stub.add({ name: 'Small', mimeType: DOC, parent: root.id, content: 'tiny' });
    stub.add({ name: 'Enormous', mimeType: DOC, parent: root.id, content: 'x'.repeat(200) });
    stub.exportLimit = 50;
    const result = await driver({ folderIds: [root.id] }).sync();
    expect(await tree()).toEqual(['Docs/Small.md']);
    expect(result.note).toContain('1 over the size limit and not indexed (Docs/Enormous.md)');
    expect(result.configPatch?.changesCursor).toBe(String(stub.changeId));
  });

  it('does not download a stored file listed over MAX_CONVERTED_FILE_BYTES', async () => {
    const root = stub.folder('Docs');
    stub.add({ name: 'small.md', parent: root.id, content: 'ok' });
    stub.add({ name: 'big.pdf', mimeType: 'application/pdf', parent: root.id, content: 'p'.repeat(100) });
    const result = await driver({ folderIds: [root.id] }, { MAX_CONVERTED_FILE_BYTES: 10 }).sync();
    expect(await tree()).toEqual(['Docs/small.md']);
    expect(result.note).toContain('over the size limit and not indexed (Docs/big.pdf)');
    expect(stub.count('media')).toBe(1);
  });

  it('recognises the refusal by its reason or its words, and nothing else as a size refusal', () => {
    const refusal = (reason: string | undefined, message: string, status = 403) => new GdriveRequestError(message, status, reason);
    expect(isExportTooLarge(refusal('exportSizeLimitExceeded', 'Google Drive export failed'))).toBe(true);
    expect(isExportTooLarge(refusal(undefined, 'Google Drive export failed: This file is too large to be exported.'))).toBe(true);
    expect(isExportTooLarge(refusal('fileNotExportable', 'Google Drive export failed: Export only supports Docs Editors files.'))).toBe(false);
    expect(isExportTooLarge(refusal('exportSizeLimitExceeded', 'x', 500))).toBe(false);
    expect(isExportTooLarge(new Error('too large'))).toBe(false);
  });
});

describe('Google’s limits and errors', () => {
  it('retries 429, a rate-limit 403 and a 5xx, honours Retry-After, and counts the first two as throttling', async () => {
    const t = handbook();
    const metrics = new MetricsRegistry();
    stub.scripted.push(
      {
        status: 429,
        body: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } },
        headers: { 'retry-after': '0' },
      },
      { status: 403, body: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } },
      { status: 503, body: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } },
    );
    const result = await driver({ folderIds: [t.root.id] }, {}, key, metrics).sync();
    expect(result.note).toContain('2 throttling answer(s) from Google');
    expect(metrics.sourceThrottled()).toEqual({ s3: 0, gdrive: 2 });
    expect(await tree()).toContain('Handbook/Guide.md');
  });

  it('gives up after five retries, counts every throttling answer, and moves no cursor', async () => {
    const t = handbook();
    const metrics = new MetricsRegistry();
    const answer = {
      status: 429,
      body: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } },
      headers: { 'retry-after': '0' },
    };
    stub.scripted.push(answer, answer, answer, answer, answer, answer, answer);
    const err = await driver({ folderIds: [t.root.id] }, {}, key, metrics)
      .sync()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GdriveRequestError);
    expect((err as GdriveRequestError).status).toBe(429);
    expect(stub.apiRequests).toBe(6);
    expect(metrics.sourceThrottled().gdrive).toBe(6);
    expect(await tree()).toEqual([]);
  });

  it('says a folder is not shared with the service account, naming the address', async () => {
    const t = handbook();
    stub.unshared.add(t.root.id);
    const message = (await driver({ folderIds: [t.root.id] })
      .sync()
      .catch((e: unknown) => e)) as Error;
    expect(message.message).toBe(`\`${t.root.id}\` is not shared with ${key.clientEmail}; share the folder with that address (Viewer is enough)`);
    await expect(driver({ folderIds: [t.root.id] }).test()).rejects.toThrow('is not shared with');
  });

  it('refuses an id that is not a folder', async () => {
    const t = handbook();
    await expect(driver({ folderIds: [t.guide.id] }).sync()).rejects.toThrow('is not a folder');
  });

  it('turns a refused key into a message about the key, never quoting it', async () => {
    const t = handbook();
    const err = (await driver({ folderIds: [t.root.id] }, {}, otherKey)
      .sync()
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GdriveAuthError);
    expect(err.message).toContain('invalid_grant');
    expect(err.message).toContain('create a new one');
    expect(err.message).not.toContain('BEGIN PRIVATE KEY');
    expect(err.message).not.toContain(otherKey.privateKey.slice(40, 80));
  });

  it('names the disabled Drive API when Google says the project has it off', async () => {
    const t = handbook();
    stub.scripted.push({
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'Google Drive API has not been used in project 1 before or it is disabled.',
          errors: [{ reason: 'accessNotConfigured' }],
        },
      },
    });
    await expect(driver({ folderIds: [t.root.id] }).test()).rejects.toThrow('Drive API is not enabled in the service account’s Google Cloud project');
  });

  it('stops at once on a source with no key stored', async () => {
    const t = handbook();
    await expect(driver({ folderIds: [t.root.id] }, {}, null).sync()).rejects.toThrow('no service account key stored');
    expect(stub.log).toEqual([]);
  });
});

describe('the egress pin', () => {
  it('refuses a download that redirects off Google’s hosts, and never sends the token there', async () => {
    const root = stub.folder('Docs');
    stub.add({ name: 'a.pdf', mimeType: 'application/pdf', parent: root.id, content: 'pdf' });
    stub.redirectDownloadsTo = `http://evil.fixture.test:${stub.port}/steal`;
    const err = (await driver({ folderIds: [root.id] })
      .sync()
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(EgressRefusedError);
    expect(err.message).toContain('the server redirected to `evil.fixture.test`');
    expect(err.message).toContain(`limited to (${TOKEN_HOST}, ${API_HOST})`);
    expect(stub.log.some((r) => r.host === 'evil.fixture.test')).toBe(false);
  });

  it('drops Authorization on a redirect between the two Google hosts', async () => {
    const root = stub.folder('Docs');
    const file = stub.add({ name: 'a.pdf', mimeType: 'application/pdf', parent: root.id, content: 'pdf' });
    stub.redirectDownloadsTo = `http://${TOKEN_HOST}:${stub.port}/drive/v3/files/${file.id}?alt=media`;
    stub.redirectOnce = true;
    await driver({ folderIds: [root.id] }).sync();
    const hops = stub.log.filter((r) => r.kind === 'media');
    // The hop to the other Google host carried no credential (it is answered 401, and the client signs in again).
    expect(hops.slice(0, 2).map((r) => [r.host, r.authorized])).toEqual([
      [API_HOST, true],
      [TOKEN_HOST, false],
    ]);
    expect(await read('Docs/a.pdf')).toBe('pdf');
  });

  it('pins by host name only, and still judges the address of a pinned host', async () => {
    const pinned = (resolve: Record<string, string>) =>
      sourceEgress({ allowedHosts: [], pinnedHosts: ['www.googleapis.com'], resolve: fakeResolver(resolve), httpsOnly: true, label: 'Google Drive' });
    const elsewhere = pinned({});
    await expect(elsewhere('https://example.com/', { method: 'GET', headers: {} })).rejects.toThrow(
      'which is not one of the hosts Google Drive is limited to (www.googleapis.com)',
    );
    const loopback = pinned({ 'www.googleapis.com': '127.0.0.1' });
    await expect(loopback('https://www.googleapis.com/', { method: 'GET', headers: {} })).rejects.toThrow(/resolves to a loopback address/);
    const insecure = pinned({ 'www.googleapis.com': '203.0.113.7' });
    await expect(insecure('http://www.googleapis.com/', { method: 'GET', headers: {} })).rejects.toThrow('only https is allowed');
    expect([...GOOGLE_HOSTS]).toEqual(['oauth2.googleapis.com', 'www.googleapis.com']);
  });
});

describe('source links (ADR-0116)', () => {
  it('serves webViewLink and modifiedTime from the listing the sync took, with no request', async () => {
    const t = handbook();
    const d = driver({ folderIds: [t.root.id] });
    await d.sync();
    stub.reset();
    const meta = await d.documentMeta([
      { path: 'Handbook/Guide.md', absolutePath: '/x', mtimeMs: 1 },
      { path: 'Handbook/unknown.md', absolutePath: '/x', mtimeMs: 1 },
    ]);
    expect(stub.log).toEqual([]);
    expect(meta.get('Handbook/Guide.md')).toEqual({
      url: `https://drive.google.com/file/d/${t.guide.id}/view`,
      modifiedAt: new Date(t.guide.modifiedTime),
    });
    expect(meta.has('Handbook/unknown.md')).toBe(false);
  });

  it('has no links before the first sync, and does not fail', async () => {
    const t = handbook();
    expect((await driver({ folderIds: [t.root.id] }).documentMeta([{ path: 'a.md', absolutePath: '/x', mtimeMs: 1 }])).size).toBe(0);
  });
});
