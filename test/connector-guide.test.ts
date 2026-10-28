import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { sourceCurrentDir } from '../src/services/data-dir.js';
import { CREDENTIAL_SOURCE_TYPES, isCredentialSourceType } from '../src/services/encrypted-fields.js';
import { walkMarkdown } from '../src/services/fs-scan.js';
import { ValidationError } from '../src/services/projects.js';
import { createSource, parseSourceConfig, PROBE_TOKEN_KEY, SOURCE_TYPES, SourceConfigByType, type SourceType } from '../src/services/sources.js';
import {
  driverFor,
  isDriverAvailable,
  registerDriver,
  type DocumentMeta,
  type DocumentMetaFile,
  type DriverContext,
  type SourceDriver,
  type SyncResult,
} from '../src/services/sources/driver.js';
import { z } from 'zod';

/**
 * `docs/contributing-a-connector.md`, followed step by step against a throwaway `dummy` type.
 *
 * Two halves. The first walks the guide's mechanisms with a driver that exists only inside this file:
 * register it, give it a settings schema, run it, and check the things the guide says hold for a type that
 * is *not* in `SOURCE_TYPES` and holds no secret. The second half keeps the guide honest — every path it
 * names exists, every symbol it tells a contributor to edit is still where it says, and every real source
 * type is present in each hand-kept table the guide lists (the ones no compiler links to `SOURCE_TYPES`).
 *
 * **The real `SOURCE_TYPES` is never touched.** The dummy is cast in, and its registration and schema are
 * removed again in `afterAll`; this module's registry is private to the test file in any case, because
 * vitest isolates each file's modules.
 */

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel: string): Promise<string> => fs.readFile(path.join(ROOT, rel), 'utf8');

const DUMMY = 'dummy' as SourceType;
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000a2';
const PROBE = 'probe-v1';

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as never;

const DummyConfig = z.object({
  greeting: z.string().min(1).default('hello'),
  [PROBE_TOKEN_KEY]: z.string().optional(),
});

/** What a driver written by the guide looks like: it reads its settings through `parseSourceConfig`. */
class DummyDriver implements SourceDriver {
  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
  ) {}

  private get dir(): string {
    return sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
  }

  async sync(): Promise<SyncResult> {
    const config = parseSourceConfig(DUMMY, this.source.config) as unknown as z.infer<typeof DummyConfig>;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'greeting.md'), `# Greeting\n\n${config.greeting}\n`);
    return { note: 'wrote 1 file', configPatch: { [PROBE_TOKEN_KEY]: PROBE } };
  }

  async docRoot(): Promise<string> {
    return this.dir;
  }

  async test(): Promise<string> {
    return 'dummy reachable';
  }

  async probe(): Promise<string | null> {
    return PROBE;
  }

  async documentMeta(files: readonly DocumentMetaFile[]): Promise<Map<string, DocumentMeta>> {
    return new Map(files.map((f) => [f.path, { url: `https://dummy.invalid/${f.path}`, modifiedAt: null }]));
  }
}

let dataDir: string;

const row = (config: Record<string, unknown> = {}): DocumentSourceRow =>
  ({ id: SOURCE_ID, projectId: PROJECT_ID, type: DUMMY, name: 'dummy-one', label: '', flavor: 'plain', config }) as unknown as DocumentSourceRow;

const context = (): DriverContext => ({
  db: null as unknown as Db,
  log,
  config: { ...WEB_LIMIT_DEFAULTS, ALLOWED_DOC_ROOTS: [dataDir], DATA_DIR: dataDir, SECRET_KEY: '0'.repeat(64), IGNORE_GLOBS: [] },
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-dummy-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  // The driver registry has no unregister (a production driver never leaves) and is private to this test
  // file's module graph; the schema table is shared by reference, so the invented key is removed from it.
  delete (SourceConfigByType as Record<string, unknown>)[DUMMY];
});

describe('the guide, followed for a dummy type', () => {
  it('step 1: a type absent from SOURCE_TYPES is refused before the database is touched', async () => {
    expect((SOURCE_TYPES as readonly string[]).includes(DUMMY)).toBe(false);
    const attempt = createSource(undefined as unknown as Db, PROJECT_ID, { type: DUMMY, name: 'dummy-one' }, {} as never);
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(attempt).rejects.toThrow(/Unknown source type "dummy"/);
  });

  it('step 4: before it is registered the type has no driver, and says so rather than guessing', () => {
    expect(isDriverAvailable(DUMMY)).toBe(false);
    expect(() => driverFor(row(), context())).toThrow(/not supported by this server/);
  });

  it('step 2: the settings schema is the single door parseSourceConfig reads', () => {
    (SourceConfigByType as Record<string, unknown>)[DUMMY] = DummyConfig;
    expect(parseSourceConfig(DUMMY, undefined)).toEqual({ greeting: 'hello' });
    expect(parseSourceConfig(DUMMY, { greeting: 'hi' })).toEqual({ greeting: 'hi' });
    expect(() => parseSourceConfig(DUMMY, { greeting: '' })).toThrow(/Invalid dummy source settings/);
  });

  it('step 4: registerDriver makes the type available and driverFor builds it from a source row', () => {
    registerDriver(DUMMY, (source, ctx) => new DummyDriver(source, ctx));
    expect(isDriverAvailable(DUMMY)).toBe(true);
    expect(driverFor(row(), context())).toBeInstanceOf(DummyDriver);
  });

  it('the sync contract: files land in the source directory and docRoot is what the indexer scans', async () => {
    (SourceConfigByType as Record<string, unknown>)[DUMMY] = DummyConfig;
    registerDriver(DUMMY, (source, ctx) => new DummyDriver(source, ctx));
    const driver = driverFor(row({ greeting: 'good morning' }), context());

    const result = await driver.sync();
    expect(result.note).toBe('wrote 1 file');

    const root = await driver.docRoot();
    expect(root).toBe(sourceCurrentDir(dataDir, PROJECT_ID, SOURCE_ID));
    const scanned: string[] = [];
    for await (const file of walkMarkdown(root, { ignoreGlobs: [] })) scanned.push(file.relativePath);
    expect(scanned).toEqual(['greeting.md']);
    expect(await fs.readFile(path.join(root, 'greeting.md'), 'utf8')).toContain('good morning');
  });

  it('the probe contract: the token sync stores is the token probe returns', async () => {
    (SourceConfigByType as Record<string, unknown>)[DUMMY] = DummyConfig;
    registerDriver(DUMMY, (source, ctx) => new DummyDriver(source, ctx));
    const driver = driverFor(row(), context());
    const { configPatch } = await driver.sync();
    expect(configPatch?.[PROBE_TOKEN_KEY]).toBe(await driver.probe?.());
  });

  it('the optional hooks: test() answers a sentence and documentMeta() never needs the network', async () => {
    registerDriver(DUMMY, (source, ctx) => new DummyDriver(source, ctx));
    const driver = driverFor(row(), context());
    expect(await driver.test?.()).toBe('dummy reachable');
    const meta = await driver.documentMeta?.([{ path: 'greeting.md', absolutePath: '/x/greeting.md', mtimeMs: 0 }]);
    expect(meta?.get('greeting.md')).toEqual({ url: 'https://dummy.invalid/greeting.md', modifiedAt: null });
  });

  it('step 8: a type that holds no secret stays off the credential list (ADR-0091)', () => {
    expect(isCredentialSourceType(DUMMY)).toBe(false);
    expect([...CREDENTIAL_SOURCE_TYPES]).toEqual(['git', 'notion', 'confluence', 's3']);
    for (const type of CREDENTIAL_SOURCE_TYPES) expect(SOURCE_TYPES).toContain(type);
  });
});

describe('the guide stays true', () => {
  let guide: string;

  beforeEach(async () => {
    guide = await read('docs/contributing-a-connector.md');
  });

  it('every repository path it names exists', () => {
    const named = [...guide.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] as string);
    const paths = named
      .map((token) => token.replace(/[:,.]+$/, ''))
      .filter((token) => /^[\w.-]+(\/[\w.-]+)+\/?$/.test(token) || token === '.env.example')
      // `.ssot/` is the planning directory of the parent repository, not part of this checkout.
      .filter((token) => !token.startsWith('.ssot/') && !token.startsWith('./'))
      // Only things with an extension or a trailing slash are claims about a path; `a/b` alone is prose.
      .filter((token) => /\.\w+$/.test(token) || token.endsWith('/') || ['drizzle'].includes(token.split('/')[0] as string));
    expect(paths.length).toBeGreaterThan(20);
    const missing = paths.filter((p) => !existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('every symbol it tells a contributor to edit exists in the file it names', async () => {
    const expectations: Array<[symbol: string, file: string]> = [
      ['SOURCE_TYPES', 'src/services/sources.ts'],
      ['SourceConfigByType', 'src/services/sources.ts'],
      ['parseSourceConfig', 'src/services/sources.ts'],
      ['validateConfig', 'src/services/sources.ts'],
      ['checkSecretAllowed', 'src/services/sources.ts'],
      ['HAS_WEBHOOK', 'src/services/sources.ts'],
      ['DEBOUNCED_WEBHOOK', 'src/services/sources.ts'],
      ['GENERATED_WEBHOOK_SECRET', 'src/services/sources.ts'],
      ['PROBE_TOKEN_KEY', 'src/services/sources.ts'],
      ['registerDriver', 'src/services/sources/driver.ts'],
      ['SourceDriver', 'src/services/sources/driver.ts'],
      ['DriverContext', 'src/services/sources/driver.ts'],
      ['SyncResult', 'src/services/sources/driver.ts'],
      ['CREDENTIAL_SOURCE_TYPES', 'src/services/encrypted-fields.ts'],
      ['SOURCE_NEEDS', 'src/services/transfer/manifest.ts'],
      ['isDriverAvailable', 'src/admin/sources-routes.ts'],
      ['SOURCE_GLYPH', 'public/app.js'],
      ['SOURCE_TITLE', 'public/app.js'],
      ['SOURCE_KINDS', 'public/app.js'],
      ['KIND_EXTENSIONS', 'public/app.js'],
      ['SECRET_FIELD', 'public/app.js'],
      ['CREDENTIALLED', 'public/app.js'],
      ['CLEAR_SECRET_ROWS', 'public/app.js'],
      ['TESTABLE', 'public/app.js'],
      ['sourceCurrentDir', 'src/services/data-dir.ts'],
    ];
    for (const [symbol, file] of expectations) {
      expect(guide, `the guide should mention ${symbol}`).toContain(symbol);
      expect(await read(file), `${file} should still define ${symbol}`).toContain(symbol);
    }
  });

  it('CONTRIBUTING.md links to it', async () => {
    expect(await read('CONTRIBUTING.md')).toContain('](docs/contributing-a-connector.md)');
  });

  it('the driver files are imported for their side effect at startup, as the guide says', async () => {
    const server = await read('src/server.ts');
    for (const type of SOURCE_TYPES.filter((t) => !['local', 'upload'].includes(t))) {
      expect(server, `src/server.ts should import the ${type} driver`).toContain(`./services/sources/${type}.js`);
    }
  });

  it('the type column has no check constraint, which is why step 3 says "usually none"', async () => {
    const schema = await read('src/db/schema.ts');
    const body = schema.match(/pgTable\(\s*'document_sources',[\s\S]*?\n\);/)?.[0] ?? '';
    expect(body).toMatch(/type: text\('type'\)/);
    expect(body).not.toMatch(/check\(['"][^'"]*type/i);
  });

  it('every real source type is present in each hand-kept table the guide lists', async () => {
    const app = await read('public/app.js');
    const html = await read('public/index.html');
    const manifest = await read('src/services/transfer/manifest.ts');
    const manifestEnum = manifest.match(/type: z\.enum\(\[([^\]]+)\]\)/)?.[1] ?? '';
    const glyph = app.match(/const SOURCE_GLYPH = \{([^}]+)\}/)?.[1] ?? '';
    const title = app.match(/const SOURCE_TITLE = \{([^}]+)\}/)?.[1] ?? '';

    for (const type of SOURCE_TYPES) {
      expect(Object.keys(SourceConfigByType), `SourceConfigByType should have ${type}`).toContain(type);
      expect(manifestEnum, `the manifest enum should list ${type}`).toContain(`'${type}'`);
      expect(glyph, `SOURCE_GLYPH should have ${type}`).toMatch(new RegExp(`\\b${type}:`));
      expect(title, `SOURCE_TITLE should have ${type}`).toMatch(new RegExp(`\\b${type}:`));
      expect(html, `index.html should have a form block for ${type}`).toMatch(new RegExp(`class="kind-only" data-kind="[^"]*\\b${type}\\b`));
    }
  });
});
