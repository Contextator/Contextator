import { describe, expect, it } from 'vitest';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { SOURCE_TYPES } from '../src/services/sources.js';
import { exportedSource, needsFor, sourceNameOf } from '../src/services/transfer/export.js';
import {
  ImportRefusedError,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  Manifest,
  checkManifest,
  dataPrefixFor,
  describeNeeds,
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

  /**
   * A Confluence source stores an API token and has no webhook, so the *only* thing it needs on the
   * other side is that token re-entered — and the operator has to be told, or the source lands
   * silently credential-less and fails on its first sync with a 401 nobody was expecting.
   *
   * It needs no new vocabulary: `needsFor` keys `credential` off `secretEnc` rather than off the type,
   * which is why a fifth source type joined this path by existing. The assertion is on the sentence an
   * operator actually reads, not on the enum member, because the enum member is not what tells them
   * anything ([ADR-0059](../.ssot/ADR.md#adr-0059)).
   */
  it('tells the destination operator to re-enter a Confluence source\u2019s API token', () => {
    const confluence = source({
      type: 'confluence',
      name: 'wiki',
      config: { baseUrl: 'https://acme.atlassian.net/wiki', email: 'docs@example.com', spaceKeys: ['ENG'] },
      webhookSecret: null,
      syncIntervalMinutes: null,
    });
    expect(needsFor(confluence)).toEqual(['credential']);

    const readme = readmeFor(manifest({ sources: [{ name: 'wiki', type: 'confluence', needs: needsFor(confluence) }] }));
    expect(readme).toContain('wiki (confluence): re-enter its access token before syncing');
    expect(readme).toContain('source credentials (1 source(s) had one)');
  });
});

/**
 * **The manifest has to be able to name every source type the product has**, or an export of a project
 * holding one it cannot name fails validation on import — and takes the *whole* import with it, not
 * just that source. This is the assertion that a new source type was added to this file too.
 */
describe('the source types the manifest can name', () => {
  it('names every type `SOURCE_TYPES` does, so no source type can make an export unreadable', () => {
    for (const type of SOURCE_TYPES) {
      const parsed = Manifest.safeParse({
        ...manifest(),
        counts: { sources: 1, documents: 0, chunks: 0, uploadFiles: 0, uploadBytes: 0 },
        sources: [{ name: 'only', type, needs: [] }],
      });
      expect(parsed.success, `manifest rejected source type "${type}"`).toBe(true);
    }
  });

  /**
   * `confluence` joined the enum and `manifestVersion` did **not** move with it, which is the decision
   * [ADR-0051](../.ssot/ADR.md#adr-0051) already made once for `mcpAuth: 'account'`: a value added to a
   * field is not a format change, and bumping the number would make every new export unreadable by
   * builds that could have read all of it but one enum member.
   */
  it('did not bump the format to add one', () => {
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe('the project floor the manifest carries', () => {
  const project = (over: Record<string, unknown>) => Manifest.parse({ ...manifest(), project: { ...manifest().project, ...over } }).project;

  it('carries a floor, null for the server default, and a 0 that turns this project off', () => {
    expect(project({ scoreFloor: 0.78 }).scoreFloor).toBe(0.78);
    expect(project({ scoreFloor: null }).scoreFloor).toBeNull();
    expect(project({ scoreFloor: 0 }).scoreFloor).toBe(0);
  });

  it('reads an export taken before the column existed, as the server default that project ran', () => {
    // The fixture is such an export: its project has no `scoreFloor` key at all.
    expect('scoreFloor' in manifest().project).toBe(false);
    expect(project({}).scoreFloor ?? null).toBeNull();
  });

  it('refuses a floor no search could be decided against', () => {
    expect(() => project({ scoreFloor: 1.2 })).toThrow();
    expect(() => project({ scoreFloor: -0.1 })).toThrow();
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

  /**
   * A Notion source's webhook secret is the `verification_token` Notion delivers, not one this
   * instance mints — and the dashboard refuses to "generate" one for anything but git (ADR-0049).
   */
  it('tells a Notion source to re-verify from Notion, never to generate a secret it cannot have', () => {
    const notion = readmeFor(
      manifest({
        counts: { sources: 2, documents: 3, chunks: 40, uploadFiles: 0, uploadBytes: 0 },
        sources: [
          { name: 'handbook', type: 'git', needs: ['credential', 'webhook-secret', 'never-scheduled'] },
          { name: 'workspace', type: 'notion', needs: ['credential', 'webhook-secret'] },
        ],
      }),
    );
    const line = notion.split('\n').find((l) => l.includes('workspace (notion):')) ?? '';
    expect(line).toContain('open a fresh verification window here and re-verify from Notion');
    expect(line).not.toContain('generate a new webhook secret');
    // The git line next to it is unchanged: the type decides only the webhook sentence.
    expect(notion).toContain('handbook (git): re-enter its access token before syncing; generate a new webhook secret here');
    expect(describeNeeds(['webhook-secret'], 'notion')).not.toContain('generate');
    expect(describeNeeds(['webhook-secret'], 'git')).toBe('generate a new webhook secret here and paste it into the provider');
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
