import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BackupRefused,
  checkSecretKey,
  checkServerVersion,
  connectionFromEnv,
  countSecretsInSourceData,
  countsNonCredentialSecrets,
  describeTopology,
  localPgTools,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  majorVersion,
  parseManifest,
  readArchiveManifest,
  redactUrl,
  secretKeyFingerprint,
  type Manifest,
} from '../scripts/backup-archive.js';
import { archiveDestination, secretKeySentences } from '../scripts/backup.js';
import { useEmbeddedDatabaseWhenNothingElseSays } from '../scripts/embedded-database.js';

/**
 * The decisions inside `backup`/`restore` that are decisions rather than mechanism
 * ([ADR-0072](../.ssot/ADR.md#adr-0072)): which key a backup needs, which server can take it, which
 * topology the command is in, and which files it will refuse outright.
 *
 * They are here rather than in the integration suite because none of them touches a database, a
 * filesystem or a `pg_dump` — and because every one of them is a *refusal*, which is the part of this
 * feature that has to be exercised in both directions cheaply and often.
 */

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    createdAt: '2026-09-22T08:00:00.000Z',
    product: { name: 'contextator', version: '0.1.0' },
    database: { mode: 'embedded', target: null, serverVersion: '16.4 (Debian 16.4-1.pgdg120+1)', dumpToolVersion: 'pg_dump (PostgreSQL) 16.4' },
    schema: { version: '5', migrations: 13 },
    secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 2, regenerableSecrets: 0 },
    counts: { projects: 1, documents: 3, chunks: 12, uploadSources: 1, uploadFiles: 2, uploadBytes: 40, databaseDumpBytes: 1024 },
    uploads: [{ project: 'handbook', source: 'manuals', path: 'projects/x/sources/y/current', files: 2, bytes: 40 }],
    ...overrides,
  };
}

describe('the key check value', () => {
  it('is the same for one key and different for another', () => {
    expect(secretKeyFingerprint(KEY)).toBe(secretKeyFingerprint(KEY));
    expect(secretKeyFingerprint(KEY)).not.toBe(secretKeyFingerprint(OTHER_KEY));
  });

  it('is 128 bits of hex and is not the key, nor a plain hash of it', () => {
    const fingerprint = secretKeyFingerprint(KEY);
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint).not.toContain(KEY);
    // The property that makes it a *check value* rather than a verifier of candidate keys: it is
    // **keyed**, so it is not the bare digest the tempting version of this would have been. That
    // version is one hash per guess for whoever holds the archive; this one is not.
    expect(fingerprint).not.toBe(createHash('sha256').update(KEY, 'utf8').digest('hex').slice(0, 32));
    // And it is not the key derivation `crypto.ts` uses either, which would have leaked the AES key.
    expect(fingerprint).not.toBe(createHash('sha256').update(KEY, 'utf8').digest('hex'));
  });
});

describe('restoring with the wrong SECRET_KEY, or none', () => {
  it('refuses a missing key when the dump holds credentials encrypted under it', () => {
    const verdict = checkSecretKey(manifest(), undefined);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('secret_key_missing');
    // The message has to carry the fingerprint: an operator with three candidate keys in a password
    // manager needs to know which one this archive wants, and the archive is the only thing that says.
    expect(verdict.message).toContain(secretKeyFingerprint(KEY));
    expect(verdict.message).toContain('Nothing has been written.');
  });

  it('refuses a key that is not the one the backup was taken under', () => {
    const verdict = checkSecretKey(manifest(), OTHER_KEY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('secret_key_mismatch');
    expect(verdict.message).toContain(secretKeyFingerprint(KEY));
    expect(verdict.message).toContain(secretKeyFingerprint(OTHER_KEY));
  });

  it('accepts the right key with nothing to say about it', () => {
    expect(checkSecretKey(manifest(), KEY)).toEqual({ ok: true, note: null });
  });

  /**
   * The refusal is about the ciphertext and not about the setting. An instance whose sources are all
   * public repositories and local directories has nothing encrypted, so a wrong key costs nothing —
   * and refusing that restore would be refusing the one case that is unambiguously safe. It is still
   * said out loud, because a key that changed silently is one nobody notices until the first private
   * source is added.
   */
  it('lets a wrong key through when no source credential depends on it, and says so', () => {
    const empty = manifest({
      secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 0, regenerableSecrets: 0 },
    });
    for (const key of [undefined, OTHER_KEY]) {
      const verdict = checkSecretKey(empty, key);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) throw new Error('unreachable');
      expect(verdict.note).toContain('no git, Notion or Confluence source in it holds a sync credential');
    }
  });

  /**
   * And it stays that case once webhooks are in the picture. A public repository with a push webhook
   * has an encrypted column — the webhook secret — but nothing a wrong key destroys: the secret is
   * re-established from this side either way, generated here for a git source and re-delivered into a
   * reopened verification window for a Notion one (ADR-0075 point 7). Counting it with the sync
   * credentials is what would turn "restore me, I have nothing to lose" into a refusal, and naming
   * only the git half is what would leave a Notion operator with a webhook that never fires again.
   */
  it('lets a wrong key through when the only encrypted values are regenerable, and names the cost', () => {
    const webhooksOnly = manifest({
      secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 0, regenerableSecrets: 3 },
    });
    for (const key of [undefined, OTHER_KEY]) {
      const verdict = checkSecretKey(webhooksOnly, key);
      expect(verdict.ok, `key ${key ?? 'none'}`).toBe(true);
      if (!verdict.ok) throw new Error('unreachable');
      expect(verdict.note).toContain('3 webhook secret(s)');
      // The remedy has to be the one that exists: regenerate and re-paste, never "re-enter by hand".
      expect(verdict.note).toContain('regenerate the secret here and paste the new one into the repository');
      // And it has to cover both provenances — Notion's secret is not one this instance can mint.
      expect(verdict.note).toContain('open a fresh verification window and re-verify from Notion');
      expect(verdict.note).not.toContain('re-entered here by hand');
    }
  });

  /**
   * A webhook secret does not turn a refusal into an acceptance, and it does not turn one into a
   * refusal either: the decision is `encryptedSources` alone, in both directions.
   */
  it('still refuses when a sync credential is at stake, whatever the webhook count is', () => {
    const both = manifest({
      secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 1, regenerableSecrets: 4 },
    });
    const verdict = checkSecretKey(both, OTHER_KEY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('secret_key_mismatch');
    expect(verdict.message).toContain('1 git, Notion or Confluence source in this backup holds a sync credential');
    expect(verdict.message).toContain('issued again by its provider and re-entered here by hand');
    // ADR-0075 point 7: named in the refusal too, never only in the acceptance — with both remedies.
    expect(verdict.message).toContain('4 webhook secret(s)');
    expect(verdict.message).toContain('regenerate the secret here and paste the new one into the repository');
    expect(verdict.message).toContain('open a fresh verification window and re-verify from Notion');
    expect(verdict.message).toMatch(/Nothing has been written\.$/);
  });

  it('names the webhook secrets in the missing-key refusal as well', () => {
    const both = manifest({
      secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 2, regenerableSecrets: 5 },
    });
    const verdict = checkSecretKey(both, undefined);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('secret_key_missing');
    expect(verdict.message).toContain('5 webhook secret(s)');
    expect(verdict.message).toContain('open a fresh verification window and re-verify from Notion');
    // …and says nothing about them when there are none.
    const credentialsOnly = checkSecretKey(manifest(), undefined);
    if (credentialsOnly.ok) throw new Error('unreachable');
    expect(credentialsOnly.message).not.toContain('webhook secret');
  });

  /**
   * Archives written before the count was split carry one number, and it meant what
   * `encryptedSources` means now. Reading one must not invent webhook secrets it never counted.
   */
  it('reads an archive written before the split as having no regenerable secrets', () => {
    const before = { ...manifest(), secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 0 } };
    const parsed = parseManifest(before);
    expect(parsed.secretKey.regenerableSecrets).toBe(0);
    const verdict = checkSecretKey(parsed, OTHER_KEY);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.note).not.toContain('webhook secret');
  });

  it('says nothing when the instance never had a key', () => {
    const none = manifest({ secretKey: { present: false, fingerprint: null, encryptedSources: 0, regenerableSecrets: 0 } });
    expect(checkSecretKey(none, undefined)).toEqual({ ok: true, note: null });
    const withKey = checkSecretKey(none, KEY);
    if (!withKey.ok) throw new Error('unreachable');
    expect(withKey.note).toContain('no SECRET_KEY');
  });
});

/**
 * What `backup` prints at the end of every run (`secretKeySentences`). ADR-0075 point 7 asks for the
 * webhook secrets to be named with their remedy, and they are the one number here that no refusal
 * elsewhere would ever make an operator notice.
 */
describe('what a backup says about SECRET_KEY on the way out', () => {
  it('names the webhook secrets and both ways of re-establishing them', () => {
    const text = secretKeySentences(
      manifest({ secretKey: { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 3, regenerableSecrets: 2 } }),
    ).join('\n');
    expect(text).toContain(`only its fingerprint, ${secretKeyFingerprint(KEY)}`);
    expect(text).toContain('3 git, Notion or Confluence source(s) in the dump hold a sync credential');
    expect(text).toContain('2 source(s) hold a webhook secret encrypted under it');
    expect(text).toContain('Those a restore does not stop for');
    expect(text).toContain('For a git source, regenerate the secret here and paste the new one into the repository');
    expect(text).toContain('for a Notion source, open a fresh verification window and re-verify from Notion');
    expect(text).toContain('Keep the key where this archive is not');
    expect(text).not.toContain(KEY);
  });

  it('says there is no key, and nothing about secrets under one, when the instance has none', () => {
    const lines = secretKeySentences(manifest({ secretKey: { present: false, fingerprint: null, encryptedSources: 0, regenerableSecrets: 0 } }));
    expect(lines.join('\n')).toContain('this instance has none set');
    expect(lines.join('\n')).not.toContain('webhook secret');
  });
});

/**
 * ADR-0091: the key refusal counts only the types that use a credential. An archive written since
 * says which types it counted; one written before did not, and may have counted a `local` row's
 * leftover secret — so the restore reads the dump's own `document_sources` rows for that archive.
 */
describe('which secrets an archive counted, and what its dump actually holds', () => {
  const CREDENTIAL = ['git', 'notion', 'confluence'] as const;
  const secretKey = { present: true, fingerprint: secretKeyFingerprint(KEY), encryptedSources: 1, regenerableSecrets: 0 };

  it('trusts a manifest that names the credential types, and doubts one that names none or more', () => {
    expect(countsNonCredentialSecrets(manifest({ secretKey: { ...secretKey, encryptedSourceTypes: [...CREDENTIAL] } }), CREDENTIAL)).toBe(false);
    expect(countsNonCredentialSecrets(manifest({ secretKey }), CREDENTIAL)).toBe(true);
    expect(countsNonCredentialSecrets(manifest({ secretKey: { ...secretKey, encryptedSourceTypes: ['git', 'local'] } }), CREDENTIAL)).toBe(true);
  });

  it('reads an archive written before the field, and keeps the field when present', () => {
    const old = parseManifest(JSON.parse(JSON.stringify(manifest({ secretKey }))));
    expect(old.secretKey.encryptedSourceTypes).toBeUndefined();
    const current = parseManifest(JSON.parse(JSON.stringify(manifest({ secretKey: { ...secretKey, encryptedSourceTypes: [...CREDENTIAL] } }))));
    expect(current.secretKey.encryptedSourceTypes).toEqual([...CREDENTIAL]);
  });

  const dumpOf = (header: string, rows: string[]) =>
    ['--', '-- Data for Name: document_sources; Type: TABLE DATA', '--', '', header, ...rows, '\\.', '', ''].join('\n');
  const HEADER = 'COPY public.document_sources (id, project_id, name, type, config, secret_enc, webhook_secret) FROM stdin;';

  it('splits stored secrets by whether the row type uses one, and ignores NULL and webhook columns', () => {
    const text = dumpOf(HEADER, [
      'a\tp\tdocs\tlocal\t{}\tv2.abc\t\\N',
      'b\tp\trepo\tgit\t{"url":"x"}\tv2.def\tv2.hook',
      'c\tp\tpub\tgit\t{}\t\\N\tv2.hook',
      'd\tp\tsite\tweb\t{}\tv2.ghi\t\\N',
      'e\tp\tws\tnotion\t{}\tv2.jkl\t\\N',
    ]);
    expect(countSecretsInSourceData(text, CREDENTIAL)).toEqual({ credential: 2, other: 2 });
  });

  it('finds the columns by name, quoted or not, whatever their order', () => {
    const text = dumpOf('COPY public."document_sources" ("secret_enc", id, "type") FROM stdin;', ['v2.x\ta\tupload', '\\N\tb\tconfluence']);
    expect(countSecretsInSourceData(text, CREDENTIAL)).toEqual({ credential: 0, other: 1 });
  });

  it('says it could not read the rows rather than reporting zero', () => {
    expect(countSecretsInSourceData('', CREDENTIAL)).toBeNull();
    expect(countSecretsInSourceData(dumpOf('COPY public.document_sources (id, type) FROM stdin;', ['a\tgit']), CREDENTIAL)).toBeNull();
  });

  it('counts an empty table as nothing at stake', () => {
    expect(countSecretsInSourceData(dumpOf(HEADER, []), CREDENTIAL)).toEqual({ credential: 0, other: 0 });
  });
});

describe('which server a dump can go into', () => {
  it('reads a major version out of every shape PostgreSQL prints one in', () => {
    expect(majorVersion('16.4 (Debian 16.4-1.pgdg120+1)')).toBe(16);
    expect(majorVersion('17.2')).toBe(17);
    expect(majorVersion('pg_restore (PostgreSQL) 17.2')).toBe(17);
    expect(majorVersion('unknown')).toBeNull();
  });

  it('calls 16 → 17 the upgrade direction and says what the restore will cost', () => {
    const verdict = checkServerVersion(manifest(), '17.2 (Debian 17.2-1.pgdg120+1)');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.note).toContain('major upgrade');
  });

  it('refuses 17 → 16, because --clean would have dropped the old database first', () => {
    const from17 = manifest({ database: { ...manifest().database, serverVersion: '17.2' } });
    const verdict = checkServerVersion(from17, '16.4');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('server_too_old');
    expect(verdict.message).toContain('Nothing has been written.');
  });

  it('says nothing when either side is a version string it does not recognise', () => {
    expect(checkServerVersion(manifest(), 'unknown')).toEqual({ ok: true, note: null });
    expect(checkServerVersion(manifest(), '16.9')).toEqual({ ok: true, note: null });
  });
});

describe('which database the command is about to talk to', () => {
  it('is the embedded one when DATABASE_URL is unset, and says the backup is the whole of it', () => {
    const topology = describeTopology({});
    expect(topology.mode).toBe('embedded');
    expect(topology.target).toBeNull();
    expect(topology.notice).toContain('embedded');
  });

  /**
   * The behaviour ADR-0069's topology obliges. On an external database this command is producing a
   * second, unmanaged copy of somebody else's production data — it still does it, because the upload
   * trees beside it are in no other backup, and it says both.
   */
  it('is external when DATABASE_URL names one, and says whose job that database is', () => {
    const topology = describeTopology({ DATABASE_URL: 'postgres://ctx:hunter2@db.example.com:5432/contextator' });
    expect(topology.mode).toBe('external');
    expect(topology.target).toBe('db.example.com:5432/contextator');
    expect(topology.notice).toContain('Nothing in this image operates that server');
    expect(topology.notice).toContain('upload trees');
    expect(topology.notice).not.toContain('hunter2');
  });

  it('never prints the credential, and prints nothing rather than a guess', () => {
    expect(redactUrl('postgres://ctx:hunter2@db:5432/contextator')).toBe('db:5432/contextator');
    expect(redactUrl('host=db port=5432 dbname=contextator')).toBeNull();
    const topology = describeTopology({ DATABASE_URL: 'host=db port=5432 dbname=contextator' });
    expect(topology.mode).toBe('external');
    expect(topology.target).toBeNull();
  });
});

describe('how libpq is told where the database is', () => {
  /**
   * Taken apart into `PG*` rather than handed to `pg_dump` as an argument: an argument is in `ps` for
   * everything else in the container, and the password is what would be in it.
   */
  it('takes DATABASE_URL apart instead of putting the password on a command line', () => {
    const connection = connectionFromEnv({ DATABASE_URL: 'postgres://ctx:hun%40ter@db.example.com:6543/books' });
    expect(connection.database).toBe('books');
    expect(connection.env).toEqual({ PGDATABASE: 'books', PGHOST: 'db.example.com', PGPORT: '6543', PGUSER: 'ctx', PGPASSWORD: 'hun@ter' });
  });

  it('adds nothing at all on the embedded topology, where the entrypoint already set PG*', () => {
    expect(connectionFromEnv({ PGDATABASE: 'contextator' })).toEqual({ env: {}, database: 'contextator' });
    expect(connectionFromEnv({ POSTGRES_DB: 'other' })).toEqual({ env: {}, database: 'other' });
    expect(connectionFromEnv({})).toEqual({ env: {}, database: 'contextator' });
  });

  it('refuses a DATABASE_URL it cannot take apart rather than passing it whole', () => {
    expect(() => connectionFromEnv({ DATABASE_URL: 'host=db dbname=contextator' })).toThrow(BackupRefused);
  });
});

describe('a file that is not one of ours', () => {
  it('names what it actually is, and points a single project at the route that moves one', () => {
    expect(() => parseManifest({ kind: 'contextator.project-export', manifestVersion: 1 })).toThrow(/project-export/);
    expect(() => parseManifest({ kind: 'contextator.project-export', manifestVersion: 1 })).toThrow(/export\/import/);
  });

  it('refuses a manifest format this build does not read, rather than guessing at the fields', () => {
    expect(() => parseManifest(manifest({ manifestVersion: MANIFEST_VERSION + 1 }))).toThrow(/manifest format/);
  });

  it('accepts the manifest `backup` writes', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(manifest())))).toEqual(manifest());
  });
});

describe('reading the manifest out of an archive', () => {
  let stage: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), 'contextator-manifest-'));
    stage = nodePath.join(dir, 'stage');
    await mkdir(stage, { recursive: true });
    // Something substantial after the manifest, so "it stopped early" is a claim about this archive
    // rather than about one small enough for the distinction not to exist.
    await writeFile(nodePath.join(stage, 'database.dump'), Buffer.alloc(2 * 1024 * 1024, 7));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function archiveOf(manifestBody: string, entries = ['manifest.json', 'database.dump']): Promise<string> {
    await writeFile(nodePath.join(stage, 'manifest.json'), manifestBody, 'utf8');
    const file = nodePath.join(dir, `${entries.join('-').replace(/[^a-z0-9-]/gi, '')}-${Math.random().toString(36).slice(2)}.tar.gz`);
    await tar.create({ gzip: true, file, cwd: stage, portable: true }, entries);
    return file;
  }

  /**
   * **This case is a regression test and the reason it exists is worth keeping.** The first version of
   * the reader used `tar.list` and aborted by throwing out of its entry callback — which does not
   * abort anything: the throw happens inside an `EventEmitter`, so the promise never settles and the
   * process dies with an uncaught exception. Measured with a probe that built exactly this archive and
   * waited; the integration suite it was first noticed in simply hung. A reader that settles is the
   * whole assertion.
   */
  it('settles — and does not take the process down — on an archive with an entry after the manifest', async () => {
    const file = await archiveOf(JSON.stringify(manifest()));
    await expect(readArchiveManifest(file)).resolves.toMatchObject({ kind: MANIFEST_KIND });
  });

  it('refuses an archive whose first entry is not the manifest', async () => {
    const file = await archiveOf(JSON.stringify(manifest()), ['database.dump', 'manifest.json']);
    await expect(readArchiveManifest(file)).rejects.toMatchObject({ code: 'not_a_backup' });
  });

  it('refuses a manifest that is not JSON, by what it is rather than by a parser error', async () => {
    const file = await archiveOf('not json at all');
    await expect(readArchiveManifest(file)).rejects.toMatchObject({ code: 'unreadable_manifest' });
  });

  it('refuses a file that is not a gzipped tar, in a sentence rather than a zlib code', async () => {
    const plain = nodePath.join(dir, 'plain.tar.gz');
    await writeFile(plain, 'this is not an archive', 'utf8');
    await expect(readArchiveManifest(plain)).rejects.toMatchObject({ code: 'not_a_backup' });
  });
});

/**
 * Where an operator command finds the database when it runs inside the shipped container — which is
 * the topology where, until this phase, it could not. See `scripts/embedded-database.ts` for what was
 * broken and how it was found.
 */
describe('the embedded database, for a command run through `docker exec`', () => {
  const inImage = { PGDATA: '/var/lib/postgresql/data', POSTGRES_USER: 'contextator', POSTGRES_DB: 'contextator' };
  const socketExists = (): boolean => true;
  const noSocket = (): boolean => false;

  it('fills in the libpq variables from the image environment the exec can actually see', () => {
    const env: NodeJS.ProcessEnv = { ...inImage, POSTGRES_PASSWORD: 'secret' };
    expect(useEmbeddedDatabaseWhenNothingElseSays(env, socketExists)).toBe('embedded');
    expect(env.PGHOST).toBe('/var/run/postgresql');
    expect(env.PGUSER).toBe('contextator');
    expect(env.PGDATABASE).toBe('contextator');
    expect(env.PGPASSWORD).toBe('secret');
  });

  /** An operator who renamed the role on the compose file must not get a command pointed at `contextator`. */
  it('reads POSTGRES_USER and POSTGRES_DB rather than assuming the defaults', () => {
    const env: NodeJS.ProcessEnv = { PGDATA: '/pgdata', POSTGRES_USER: 'other', POSTGRES_DB: 'books' };
    expect(useEmbeddedDatabaseWhenNothingElseSays(env, socketExists)).toBe('embedded');
    expect(env.PGUSER).toBe('other');
    expect(env.PGDATABASE).toBe('books');
  });

  it('never overrides an answer the environment already has', () => {
    for (const given of [{ DATABASE_URL: 'postgres://db/x' }, { PGHOST: 'db.example.com' }, { PGDATABASE: 'named' }]) {
      const env: NodeJS.ProcessEnv = { ...inImage, ...given };
      expect(useEmbeddedDatabaseWhenNothingElseSays(env, socketExists)).toBe('configured');
      expect(env).toEqual({ ...inImage, ...given });
    }
  });

  /** A checkout with no `.env`, and the `slim` image, which has neither a PGDATA nor a socket. */
  it('does nothing where there is no embedded PostgreSQL, so the old error is still the error', () => {
    const bare: NodeJS.ProcessEnv = {};
    expect(useEmbeddedDatabaseWhenNothingElseSays(bare, socketExists)).toBe('configured');
    expect(bare).toEqual({});
    const slim: NodeJS.ProcessEnv = { ...inImage };
    expect(useEmbeddedDatabaseWhenNothingElseSays(slim, noSocket)).toBe('configured');
    expect(slim).toEqual(inImage);
  });
});

/**
 * The adapter every operator invocation actually runs — `spawn`, the environment merge, and the
 * refusal the `slim` image produces — which nothing exercised until this file did.
 *
 * **It is driven by putting a directory on `PATH`, not by handing `localPgTools` a way to rename the
 * tool.** The host this suite runs on has no PostgreSQL client installed — which is
 * [ADR-0046](../.ssot/ADR.md#adr-0046)'s own reason for running the real tools beside the server — so
 * the choice was between a redirection parameter that exists only for tests and a fake `pg_dump` on
 * the path. The fake is better on both counts: nothing test-shaped survives in the production
 * signature, and the lookup being exercised is the lookup an operator's container does.
 */
describe('the tools on this process\u2019s own PATH', () => {
  const connection = { env: { PGDATABASE: 'from-the-connection' }, database: 'from-the-connection' };
  let bin: string;
  let empty: string;
  /** A client installed halfway: `pg_dump` and nothing else. */
  let half: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'contextator-pgbin-'));
    bin = nodePath.join(root, 'bin');
    empty = nodePath.join(root, 'empty');
    half = nodePath.join(root, 'half');
    await mkdir(bin, { recursive: true });
    await mkdir(empty, { recursive: true });
    await mkdir(half, { recursive: true });
    // A `pg_dump` that answers `--version` and otherwise prints what libpq would have been told, so
    // the environment merge is observable from the child rather than asserted on the parent.
    await writeFile(
      nodePath.join(bin, 'pg_dump'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 99.9 (fake)"; exit 0; fi',
        // `$PATH` unbraced, because a `${…}` here is shell but reads as a template hole to a linter.
        'if [ -n "$PATH" ]; then has_path=yes; else has_path=no; fi',
        'echo "$PGDATABASE|$has_path"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    // …and a `pg_restore` that fails the way a real one does when something goes wrong.
    await writeFile(nodePath.join(bin, 'pg_restore'), ['#!/bin/sh', 'echo boom >&2', 'exit 3', ''].join('\n'), { mode: 0o755 });
    await writeFile(nodePath.join(half, 'pg_dump'), ['#!/bin/sh', 'echo "pg_dump (PostgreSQL) 99.9 (half)"', ''].join('\n'), { mode: 0o755 });
    originalPath = process.env.PATH;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  /** `localPgTools` captures the environment when it is built, so the path is set before that. */
  function toolsWith(pathDir: string): ReturnType<typeof localPgTools> {
    process.env.PATH = pathDir;
    try {
      return localPgTools('/tmp', connection);
    } finally {
      process.env.PATH = originalPath;
    }
  }

  it('finds the tool by its own name on the PATH and gives back what it printed', async () => {
    await expect(toolsWith(bin).version('pg_dump')).resolves.toBe('pg_dump (PostgreSQL) 99.9 (fake)');
  });

  /** The merge is what carries a DATABASE_URL's credentials to libpq without putting them in argv. */
  it('hands the child the connection environment merged over this process\u2019s own', async () => {
    expect((await toolsWith(bin).run('pg_dump', [])).trim()).toBe('from-the-connection|yes');
  });

  it('reports the exit code and what went to stderr, rather than an empty failure', async () => {
    await expect(toolsWith(bin).run('pg_restore', [])).rejects.toThrow(/exited 3.*boom/s);
  });

  /**
   * FR-576's last sentence, which had no test behind it: on the `slim` image there is no `pg_dump`,
   * and the command has to say that rather than die at `ENOENT`.
   */
  it('refuses by name when the tool is not on the PATH, and names the image that has it', async () => {
    const tools = toolsWith(empty);
    await expect(tools.version('pg_dump')).rejects.toMatchObject({ code: 'no_pg_tools' });
    await expect(tools.version('pg_dump')).rejects.toThrow(/-slim/);
    await expect(tools.version('pg_dump')).rejects.toThrow(/`pg_dump` is not on the PATH/);
  });

  it('looks for each tool under its own name, so a half-installed client is named correctly', async () => {
    // `pg_dump` is on this path and `pg_restore` is not: the one that is there is found, and the refusal
    // quotes the one asked for rather than the first tool of the pair.
    const tools = toolsWith(half);
    await expect(tools.version('pg_dump')).resolves.toBe('pg_dump (PostgreSQL) 99.9 (half)');
    await expect(tools.version('pg_restore')).rejects.toMatchObject({ code: 'no_pg_tools' });
    await expect(tools.version('pg_restore')).rejects.toThrow(/`pg_restore` is not on the PATH/);
    await expect(tools.version('pg_restore')).rejects.not.toThrow(/`pg_dump`/);
  });
});

describe('where an unnamed archive goes', () => {
  /**
   * Inside the container the working directory is `/app` — an image layer, not a volume. An archive
   * written there survives exactly until the container is recreated, and the person who discovers
   * that is the person who went looking for the backup.
   */
  it('lands under DATA_DIR, on a volume, and never in the working directory', () => {
    const at = new Date('2026-09-22T12:00:00.000Z');
    const chosen = archiveDestination(undefined, { DATA_DIR: '/data' }, at);
    expect(chosen).toBe('/data/backups/contextator-backup-2026-09-22T12-00-00Z.tar.gz');
    expect(chosen.startsWith('/data/')).toBe(true);
    expect(chosen).not.toContain(process.cwd());
  });

  it('is whatever the operator named, when they named one', () => {
    expect(archiveDestination('/srv/backups/mine.tar.gz', { DATA_DIR: '/data' })).toBe('/srv/backups/mine.tar.gz');
  });
});
