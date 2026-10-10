import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { keyringOf } from '../src/services/crypto.js';
import { exportedSource } from '../src/services/transfer/export.js';
import { createSource, parseSourceConfig, toSourceView, updateSource, type SourceServiceOptions } from '../src/services/sources.js';

/**
 * A credential pasted into a git source's URL must not reach `document_sources.config`, and must not
 * come back from `toSourceView` either ([ADR-0075](../.ssot/ADR.md#adr-0075)). Authentication reads
 * `secret_enc` alone, so the URL loses nothing by being clean.
 */

const PASTED = 'https://alice:ghp_s3cret@github.com/org/repo.git';
const CLEAN = 'https://github.com/org/repo.git';
const opts: SourceServiceOptions = { allowedRoots: [], keys: keyringOf({ SECRET_KEY: '0'.repeat(64) }) };
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

function row(config: Record<string, unknown>, type = 'git'): DocumentSourceRow {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    projectId: PROJECT_ID,
    type,
    name: 'docs',
    label: '',
    flavor: 'plain',
    config,
    secretEnc: null,
    webhookSecret: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    createdAt: new Date(),
  } as unknown as DocumentSourceRow;
}

/** Just enough of the query builder for `createSource` and `updateSource`; records what was written. */
function fakeDb(existing?: DocumentSourceRow): { db: Db; written: () => Record<string, unknown> } {
  let written: Record<string, unknown> = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (existing ? [existing] : []) }) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        written = v;
        return { returning: async () => [row(v.config as Record<string, unknown>)] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        written = v;
        return { where: () => ({ returning: async () => [{ ...existing, ...v }] }) };
      },
    }),
  } as unknown as Db;
  return { db, written: () => written };
}

describe('a git URL with credentials in it', () => {
  it('is stripped when a source is created, in what is stored and in what is returned', async () => {
    const { db, written } = fakeDb();
    const created = await createSource(db, PROJECT_ID, { type: 'git', name: 'docs', config: { url: PASTED } }, opts);
    expect((written().config as { url: string }).url).toBe(CLEAN);
    expect(toSourceView(created, { keys: opts.keys }).config.url).toBe(CLEAN);
    expect(JSON.stringify(written())).not.toContain('ghp_s3cret');
  });

  it('is stripped when a source is updated, whether the URL is new or was already stored dirty', async () => {
    const dirty = row({ url: PASTED, branch: 'main' });
    const sent = fakeDb(dirty);
    const updated = await updateSource(sent.db, PROJECT_ID, dirty.id, { config: { url: 'https://bob:tok@gitlab.com/g/r.git' } }, opts);
    expect((sent.written().config as { url: string }).url).toBe('https://gitlab.com/g/r.git');
    expect(toSourceView(updated, { keys: opts.keys }).config.url).toBe('https://gitlab.com/g/r.git');

    // An edit that does not touch the URL still rewrites the stored one clean.
    const untouched = fakeDb(dirty);
    await updateSource(untouched.db, PROJECT_ID, dirty.id, { config: { branch: 'dev' } }, opts);
    expect((untouched.written().config as { url: string }).url).toBe(CLEAN);
  });

  it('is stripped from the view of a row stored before the fix, with no migration needed', () => {
    const view = toSourceView(row({ url: PASTED }), { keys: opts.keys });
    expect(view.config.url).toBe(CLEAN);
    expect(JSON.stringify(view)).not.toContain('ghp_s3cret');
    // A token with no password half is a credential as well.
    expect(toSourceView(row({ url: 'https://ghp_tok@github.com/org/repo.git' }), { keys: opts.keys }).config.url).toBe(CLEAN);
  });

  it('is stripped by parseSourceConfig, which project import also goes through', () => {
    expect(parseSourceConfig('git', { url: PASTED }).url).toBe(CLEAN);
  });
});

describe('a git URL without credentials', () => {
  it('is left exactly as written, in parse, in what is stored and in the view', async () => {
    for (const url of [CLEAN, 'https://example.com', 'https://git.example.com:8443/a/b.git?x=1']) {
      expect(parseSourceConfig('git', { url }).url).toBe(url);
    }
    const { db, written } = fakeDb();
    const created = await createSource(db, PROJECT_ID, { type: 'git', name: 'docs', config: { url: CLEAN } }, opts);
    expect((written().config as { url: string }).url).toBe(CLEAN);
    expect(toSourceView(created, { keys: opts.keys }).config.url).toBe(CLEAN);
    // The bare host would gain a trailing slash if it went through `URL.toString()`.
    expect(toSourceView(row({ url: 'https://example.com' }), { keys: opts.keys }).config.url).toBe('https://example.com');
  });

  it('does not touch the config of a source that is not a git one', () => {
    const config = { url: 'https://user:pw@example.com/page' };
    expect(toSourceView(row(config, 'web'), { keys: opts.keys }).config).toEqual(config);
  });
});

describe('a project export archive', () => {
  it('carries the clean URL of a git row stored before the URL was stripped on write', () => {
    expect((exportedSource(row({ url: PASTED, branch: 'main' })).config as { url: string }).url).toBe(CLEAN);
    expect(JSON.stringify(exportedSource(row({ url: PASTED })))).not.toContain('ghp_s3cret');
  });

  it('leaves a credential-free git URL and a non-git source as they were', () => {
    expect((exportedSource(row({ url: 'https://example.com' })).config as { url: string }).url).toBe('https://example.com');
    const web = { url: 'https://user:pw@example.com/page' };
    expect(exportedSource(row(web, 'web')).config).toEqual(web);
  });
});
