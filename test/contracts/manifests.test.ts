import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as backup from '../../scripts/backup-archive.js';
import * as transfer from '../../src/services/transfer/manifest.js';
import { recordJson, withoutWording } from '../support/contract-json.js';

/**
 * **The archive manifests as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 1): what an
 * instance backup ([ADR-0072](../../.ssot/ADR.md#adr-0072)) and a project export
 * ([ADR-0051](../../.ssot/ADR.md#adr-0051)) say about themselves, which is what a later release has to keep
 * reading. 1.x reads every archive an earlier 1.x wrote.
 *
 * - `__snapshots__/backup-manifest.json` and `__snapshots__/export-manifest.json` — `kind`,
 *   `manifestVersion`, the names of the entries inside the tarball, and `z.toJSONSchema(Manifest, { io:
 *   'input' })`: every field, its type, bounds, whether it is optional or has a default. `title` and
 *   `description` are dropped (Tier 3). Keys are sorted.
 * - `fixtures/backup-manifest-v1*.json` and `fixtures/export-manifest-v1*.json` — **read-compatibility.**
 *   One real manifest of each per release that wrote them, `manifestVersion: 1`: `…-v1.json` as the 0.7
 *   development line wrote it, `…-v1-1.0.0.json` as 1.0.0 wrote it. Each must be read by today's parser *and
 *   come back whole*: the parsed value equals the file, so a field the schema stopped knowing (which zod would
 *   strip without a word) fails here even though the file still "parses".
 *
 * **How the fixtures were made — they are not hand-written.** Against a PostgreSQL 16 + pgvector database
 * from the integration harness, with one project (`handbook`), an upload source with one Markdown file, a
 * git source with an encrypted token and webhook secret and one indexed document: `runBackup` from
 * `scripts/backup.ts` (the backup manifest is `result.manifest`) and `exportProject` from
 * `src/services/transfer/export.ts` (the export manifest is `result.manifest`), each written with
 * `JSON.stringify(manifest, null, 2)` and then formatted by `biome format`, the only touch. They carry the
 * product version of the checkout that wrote them (`0.6.1`, in the 0.7 development line) and the
 * database/instance facts of that run. Nothing was edited by hand.
 *
 * **The `…-v1-1.0.0.json` pair was made the same way, with the same seed, from the 1.0.0 checkout** (product
 * version `1.0.0`, PostgreSQL 16.15 container, a project `handbook` with an upload source `manuals` holding one
 * 30-byte Markdown file and one indexed document, and a git source `private-repo` with an encrypted token and
 * webhook secret); only the identifiers and timestamps of that run differ.
 *
 * **They are kept for the whole of 1.x.** The archives 1.0.0 writes sit beside the ones 0.7 wrote
 * (`…-v1.json` stay: they are what 0.7 wrote and 1.x promises to read). A later 1.x that writes a new
 * archive shape adds its own pair; no fixture is replaced.
 *
 * Re-record the schema snapshots after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * **The fixtures are pinned in a snapshot, so changing one is a visible, gated change.** `__snapshots__/fixtures.json`
 * holds the SHA-256 of every file in `fixtures/`. CI's changelog check (`.github/workflows/ci.yml`) watches
 * `__snapshots__/`, so a pull request that edits, replaces or removes a fixture (or adds one) changes that file
 * and needs a `CHANGELOG.md` entry; without it the fixtures could be narrowed to fit a parser that lost a field.
 *
 * The fixtures are never regenerated to make a failure go away: a fixture that stopped parsing is the
 * contract broken. Outside CI a missing snapshot file is written silently; run with `CI=1` to check.
 */

const SNAPSHOTS = path.join(import.meta.dirname, '__snapshots__');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

const schemaOf = (manifest: z.ZodType): unknown => withoutWording(z.toJSONSchema(manifest, { io: 'input' }));

describe('the read-compatibility fixtures are pinned', () => {
  it('records the hash of every fixture file', async () => {
    const names = readdirSync(FIXTURES).sort();
    expect(names).toEqual(['backup-manifest-v1-1.0.0.json', 'backup-manifest-v1.json', 'export-manifest-v1-1.0.0.json', 'export-manifest-v1.json']);
    const hashes = Object.fromEntries(
      names.map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(path.join(FIXTURES, name)))
          .digest('hex'),
      ]),
    );
    await expect(recordJson(hashes)).toMatchFileSnapshot(path.join(SNAPSHOTS, 'fixtures.json'));
  });
});

describe('the backup manifest is a contract', () => {
  it('records its kind, version, entries and every field', async () => {
    const schema = schemaOf(backup.Manifest) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('secretKey');
    await expect(
      recordJson({
        entries: { database: backup.DATABASE_ENTRY, dataPrefix: backup.DATA_PREFIX, manifest: backup.MANIFEST_ENTRY, readme: backup.README_ENTRY },
        kind: backup.MANIFEST_KIND,
        manifestVersion: backup.MANIFEST_VERSION,
        schema,
      }),
    ).toMatchFileSnapshot(path.join(SNAPSHOTS, 'backup-manifest.json'));
  });

  it.each([
    ['0.7', 'backup-manifest-v1.json'],
    ['1.0.0', 'backup-manifest-v1-1.0.0.json'],
  ])('reads the manifestVersion 1 archive %s wrote, and loses no field of it', (_release, name) => {
    const raw = fixture(name) as { kind: string; manifestVersion: number };
    expect(raw.kind).toBe(backup.MANIFEST_KIND);
    expect(raw.manifestVersion).toBe(1);
    expect(backup.parseManifest(raw)).toEqual(raw);
  });
});

describe('the project export manifest is a contract', () => {
  it('records its kind, version, entries and every field', async () => {
    const schema = schemaOf(transfer.Manifest) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('excluded');
    await expect(
      recordJson({
        entries: {
          dataPrefix: transfer.DATA_PREFIX,
          documents: transfer.DOCUMENTS_ENTRY,
          goldenQuestions: transfer.GOLDEN_QUESTIONS_ENTRY,
          manifest: transfer.MANIFEST_ENTRY,
          readme: transfer.README_ENTRY,
          sources: transfer.SOURCES_ENTRY,
        },
        kind: transfer.MANIFEST_KIND,
        manifestVersion: transfer.MANIFEST_VERSION,
        schema,
        sourceNeeds: transfer.SOURCE_NEEDS,
      }),
    ).toMatchFileSnapshot(path.join(SNAPSHOTS, 'export-manifest.json'));
  });

  it.each([
    ['0.7', 'export-manifest-v1.json'],
    ['1.0.0', 'export-manifest-v1-1.0.0.json'],
  ])('reads the manifestVersion 1 export %s wrote, and loses no field of it', (_release, name) => {
    const raw = fixture(name) as { kind: string; manifestVersion: number };
    expect(raw.kind).toBe(transfer.MANIFEST_KIND);
    expect(raw.manifestVersion).toBe(1);
    expect(transfer.Manifest.parse(raw)).toEqual(raw);
  });
});
