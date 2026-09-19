import { describe, expect, it } from 'vitest';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { exportedSource, needsFor, sourceNameOf } from '../src/services/transfer/export.js';
import {
  ImportRefusedError,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  Manifest,
  checkManifest,
  dataPrefixFor,
  readmeFor,
} from '../src/services/transfer/manifest.js';

/**
 * The half of the project export that is a decision rather than a mechanism
 * ([ADR-0051](../.ssot/ADR.md#adr-0051)): what a source is allowed to carry, and every reason an
 * import stops before it has written anything.
 *
 * The round trip itself is `test/integration/project-transfer.itest.ts`, which needs two databases.
 */

const source = (over: Partial<DocumentSourceRow> = {}): DocumentSourceRow =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    type: 'git',
    name: 'handbook',
    label: 'The handbook',
    config: { url: 'https://example.invalid/x.git', branch: 'main', lastCommit: 'deadbeef', syncProbeToken: 'etag-42' },
    secretEnc: 'v1.aaa.bbb.ccc',
    webhookSecret: '0123456789abcdef',
    flavor: 'plain',
    status: 'idle',
    lastSyncedAt: new Date('2026-09-01T00:00:00Z'),
    lastError: null,
    documentCount: 3,
    syncIntervalMinutes: 60,
    nextSyncAt: new Date('2026-09-02T00:00:00Z'),
    webhookVerificationExpiresAt: new Date('2026-09-02T00:00:00Z'),
    webhookDueAt: new Date('2026-09-02T00:05:00Z'),
    webhookMinIntervalMinutes: 5,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }) as DocumentSourceRow;

const manifest = (over: Partial<Manifest> = {}): Manifest =>
  Manifest.parse({
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    createdAt: '2026-09-19T10:00:00.000Z',
    product: { name: 'contextator', version: '0.1.0' },
    schema: { version: '5', migrations: 8 },
    instance: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publicBaseUrl: 'https://docs.example.invalid' },
    embedding: { id: 'local:Xenova/multilingual-e5-small:fp32:q+p', dimensions: 384 },
    project: { name: 'handbook', exportedGeneration: 7, mcpAuth: 'token', queryLogEnabled: true, lastIndexedAt: null },
    counts: { sources: 1, documents: 3, chunks: 40, uploadFiles: 0, uploadBytes: 0 },
    excluded: { searchQueries: 12, searchQueryHits: 40, mcpTokens: 2, indexRuns: 9, projectMembers: { viewer: 3, editor: 1 } },
    sources: [{ name: 'handbook', type: 'git', needs: ['credential', 'webhook-secret', 'never-scheduled'] }],
    ...over,
  });

const here = { embeddingId: 'local:Xenova/multilingual-e5-small:fp32:q+p', embeddingDimensions: 384, migrations: 8 };

describe('what a source is allowed to carry', () => {
  /**
   * The assertion is on the **key set** and not on a handful of fields. A column added to
   * `document_sources` tomorrow joins this row and therefore this test, which is the property a
   * `{ ...row }` spread would have quietly given up.
   */
  it('names its fields, so a new column cannot join the export by being added', () => {
    expect(Object.keys(exportedSource(source())).sort()).toEqual([
      'config',
      'flavor',
      'label',
      'name',
      'syncIntervalMinutes',
      'type',
      'webhookMinIntervalMinutes',
    ]);
  });

  it('carries neither secret, in either provenance', () => {
    const exported = JSON.stringify(exportedSource(source()));
    expect(exported).not.toContain('v1.aaa.bbb.ccc');
    expect(exported).not.toContain('0123456789abcdef');
    // A Notion source's `webhook_secret` is a token Notion minted for the *source* instance's
    // subscription, and it must not travel either — same column, same rule, other direction.
    const notion = JSON.stringify(exportedSource(source({ type: 'notion', webhookSecret: 'secret_notion_token' })));
    expect(notion).not.toContain('secret_notion_token');
  });

  /** A revision token is a statement about a tree on a disk the destination does not have. */
  it('drops the probe token and the last commit, so the destination re-syncs instead of believing it has', () => {
    const config = exportedSource(source()).config as Record<string, unknown>;
    expect(config).not.toHaveProperty('syncProbeToken');
    expect(config).not.toHaveProperty('lastCommit');
    expect(config.url).toBe('https://example.invalid/x.git');
  });
});

describe('what the export says a source will need on the other side', () => {
  it('reports a credential, a webhook secret and the scheduling it is about to lose', () => {
    expect(needsFor(source())).toEqual(['credential', 'webhook-secret', 'never-scheduled']);
  });

  it('marks an upload source as the one whose files are in the tarball', () => {
    expect(needsFor(source({ type: 'upload', secretEnc: null, webhookSecret: null, syncIntervalMinutes: null }))).toEqual(['files-carried']);
  });

  it('marks a local source as one whose path belongs to the machine the export came from', () => {
    expect(needsFor(source({ type: 'local', secretEnc: null, webhookSecret: null, syncIntervalMinutes: null }))).toEqual(['path-on-this-host']);
  });

  it('says nothing about a source that needs nothing', () => {
    expect(needsFor(source({ type: 'git', secretEnc: null, webhookSecret: null, syncIntervalMinutes: null }))).toEqual([]);
  });
});

describe('the refusals, decided from the manifest before a byte of data is read', () => {
  it('accepts a file this instance is the right home for', () => {
    expect(() => checkManifest(manifest(), here)).not.toThrow();
  });

  it('refuses another model, and names both of them', () => {
    expect(() => checkManifest(manifest(), { ...here, embeddingId: 'local:Xenova/all-MiniLM-L6-v2:fp32' })).toThrow(ImportRefusedError);
    try {
      checkManifest(manifest(), { ...here, embeddingId: 'local:Xenova/all-MiniLM-L6-v2:fp32' });
      expect.unreachable();
    } catch (err) {
      expect((err as ImportRefusedError).code).toBe('model_mismatch');
      expect((err as Error).message).toContain('local:Xenova/multilingual-e5-small:fp32:q+p');
      expect((err as Error).message).toContain('local:Xenova/all-MiniLM-L6-v2:fp32');
    }
  });

  it('refuses another dimension even when the model id happens to match', () => {
    try {
      checkManifest(manifest(), { ...here, embeddingDimensions: 768 });
      expect.unreachable();
    } catch (err) {
      expect((err as ImportRefusedError).code).toBe('dimension_mismatch');
    }
  });

  /**
   * A project that has never been indexed carries no vectors, so there is nothing for a mismatch to be
   * a mismatch with. Refusing it would refuse the one import that is unambiguously safe.
   */
  it('accepts a project with no vectors into an instance running anything', () => {
    expect(() =>
      checkManifest(manifest({ embedding: null }), { ...here, embeddingId: 'openai:text-embedding-3-small', embeddingDimensions: 1536 }),
    ).not.toThrow();
  });

  it('refuses a manifest format it does not know, rather than guessing at the fields', () => {
    try {
      checkManifest(manifest({ manifestVersion: MANIFEST_VERSION + 1 }), here);
      expect.unreachable();
    } catch (err) {
      expect((err as ImportRefusedError).code).toBe('manifest_too_new');
    }
  });

  /** The schema check runs in one direction: forward is a refusal, backward is the supported case. */
  it('refuses a newer schema and accepts an older one', () => {
    expect(() => checkManifest(manifest({ schema: { version: '5', migrations: 9 } }), here)).toThrow(/migrations in/);
    expect(() => checkManifest(manifest({ schema: { version: '5', migrations: 3 } }), here)).not.toThrow();
  });

  it('is not a manifest at all without the kind that says what it is', () => {
    expect(Manifest.safeParse({ ...manifest(), kind: 'something.else' }).success).toBe(false);
  });
});

describe('the prose the tarball carries', () => {
  const text = readmeFor(manifest());

  it('states the generation that was exported and that it does not travel', () => {
    expect(text).toContain('generation 7');
    expect(text).toContain('renumbers this corpus to 0');
  });

  it('counts every exclusion out loud, memberships included', () => {
    expect(text).toContain('12 logged searches');
    expect(text).toContain('2 MCP token(s)');
    expect(text).toContain('9 index run record(s)');
    expect(text).toContain('3 viewer and 1 editor membership(s)');
  });

  it('says what each source needs here, in words', () => {
    expect(text).toContain('handbook (git): re-enter its access token');
    expect(text).toContain('paste it into the provider');
  });
});

describe('how the two halves of the tarball agree on which source is which', () => {
  /**
   * By **name** and never by id. A `document_sources.id` is a uuid of the database the export came
   * from; the name is unique per project and is already the prefix of every one of that source's
   * document paths, which is the same handle `search_docs`' `source` filter has always used.
   */
  it('keys the carried files by the source name the document paths already carry', () => {
    expect(dataPrefixFor('handbook')).toBe('data/sources/handbook');
    expect(sourceNameOf('handbook/guides/install.md')).toBe('handbook');
    expect(sourceNameOf('handbook/install.md')).toBe('handbook');
  });

  it('gives no source name to a document that has no prefix', () => {
    // The evaluation harness writes documents with no `document_sources` row at all (ADR-0034).
    expect(sourceNameOf('install.md')).toBeNull();
    expect(sourceNameOf('/leading.md')).toBeNull();
  });
});
