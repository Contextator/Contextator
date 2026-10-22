import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, isNotNull, notInArray, sql } from 'drizzle-orm';
import * as tar from 'tar';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { documentSources } from '../src/db/schema.js';
import { CREDENTIAL_SOURCE_TYPES } from '../src/services/encrypted-fields.js';
import {
  BackupRefused,
  checkSecretKey,
  checkServerVersion,
  connectionFromEnv,
  countSecretsInSourceData,
  countsNonCredentialSecrets,
  DATABASE_ENTRY,
  DATA_PREFIX,
  describeTopology,
  localPgTools,
  MANIFEST_ENTRY,
  README_ENTRY,
  readArchiveManifest,
  type Manifest,
  type PgTools,
  type Topology,
} from './backup-archive.js';
import { fetchArchive, S3Client, s3TargetFromEnv } from './backup-s3.js';
import { useEmbeddedDatabaseWhenNothingElseSays } from './embedded-database.js';

/**
 * `npm run restore -- <file.tar.gz>` — the other half, and the half whose order matters
 * ([ADR-0072](../.ssot/ADR.md#adr-0072)).
 *
 * **Every refusal is decided before anything is written.** The manifest is the first entry in the
 * archive and is read on its own; the key check value, the server's major version and the presence of
 * `pg_restore` are all judged from it and from this environment, and only then is a byte unpacked. The
 * failure this ordering exists to prevent is the one that costs the most: a `pg_restore --clean` that
 * has already dropped the old database when it discovers the key it needed is not here. An operator
 * who then reaches for the same archive a second time, with the right key, has nothing to reach for on
 * a rollback — the thing they were rolling back from is gone.
 *
 * `--check` stops after the refusals and prints what a real run would do. It writes nothing, so it is
 * the safe way to ask "is this archive the one I think it is, and can this instance take it".
 *
 * **Only a credential stops it** ([ADR-0091](../.ssot/ADR.md#adr-0091)). The key refusal counts the
 * `git`, `notion` and `confluence` rows holding a `secret_enc`; a secret on a `local`, `upload` or
 * `web` row is one nothing ever read, and it is dropped after the restore — set to NULL, and the
 * number printed — rather than refusing over it. An archive written before the manifest said which
 * types it counted may have counted those rows too; when that archive would be refused, the restore
 * reads the one table out of the dump and judges on the rows themselves, still before it touches the
 * target. That read unpacks only the dump into staging and removes it again, under `--check` too.
 */

const STAGING = '.restore';

export interface RestoreDeps {
  db: Db;
  config: Config;
  tools: PgTools;
  topology: Topology;
  /** `SECRET_KEY` as this environment has it; the check is about this value and never about a row. */
  secretKey: string | undefined;
  say: (line: string) => void;
}

export interface RestoreResult {
  manifest: Manifest;
  /** True when `--check` stopped it: every refusal was evaluated and nothing was written. */
  checkedOnly: boolean;
  uploadsRestored: number;
  /** `secret_enc` values set to NULL on `local`, `upload` and `web` rows after the restore (ADR-0091). */
  droppedSecrets: number;
}

/**
 * The credential-type secret count of an archive whose manifest may have counted every type — read
 * from the dump's `document_sources` rows, not from the manifest's claim about them.
 *
 * Only `database.dump` is unpacked, into the same staging the restore itself uses, and the staging is
 * removed again whatever happens: this runs before any refusal is final, and a refused restore leaves
 * nothing behind. `null` when the rows could not be read; the caller then keeps the manifest's number,
 * which can only refuse more.
 */
async function secretsInDump(tools: PgTools, archive: string): Promise<{ credential: number; other: number } | null> {
  await tools.version('pg_restore');
  await fs.rm(tools.scratch.local, { recursive: true, force: true });
  await fs.mkdir(tools.scratch.local, { recursive: true });
  try {
    await tar.extract({ file: archive, cwd: tools.scratch.local, filter: (entry) => entry === DATABASE_ENTRY });
    const found = await fs.stat(path.join(tools.scratch.local, DATABASE_ENTRY)).catch(() => null);
    if (!found?.isFile()) return null;
    // Without `-d`, `pg_restore` writes SQL; `-f -` sends it to stdout (PostgreSQL 12+ requires it).
    // Nothing connects to a database here.
    const sqlText = await tools.run('pg_restore', [
      '--data-only',
      '--table=document_sources',
      '-f',
      '-',
      path.join(tools.scratch.remote, DATABASE_ENTRY),
    ]);
    return countSecretsInSourceData(sqlText, CREDENTIAL_SOURCE_TYPES);
  } finally {
    await fs.rm(tools.scratch.local, { recursive: true, force: true });
  }
}

/**
 * The entries this command will unpack, and nothing else.
 *
 * `tar` already refuses absolute paths and `..` segments on extraction, so this is not the path
 * traversal guard — it is the narrower statement that an archive carrying anything beyond the four
 * shapes `backup` writes is not going to have it written into `DATA_DIR` silently.
 */
function permitted(entryPath: string): boolean {
  if (entryPath === MANIFEST_ENTRY || entryPath === README_ENTRY || entryPath === DATABASE_ENTRY) return true;
  return entryPath === DATA_PREFIX || entryPath.startsWith(`${DATA_PREFIX}/`);
}

/** A manifest's upload path, judged before it is joined to anything. */
const UPLOAD_PATH_RE = /^projects\/[0-9a-f-]{36}\/sources\/[0-9a-f-]{36}\/current$/i;

async function serverVersion(db: Db): Promise<string> {
  const result = await db.execute(sql`SHOW server_version`);
  return (result.rows[0] as { server_version: string } | undefined)?.server_version ?? 'unknown';
}

export async function runRestore(deps: RestoreDeps, archivePath: string, opts: { check?: boolean } = {}): Promise<RestoreResult> {
  const { db, config, tools, topology, secretKey, say } = deps;
  const archive = path.resolve(archivePath);

  // ── Everything that can refuse, before anything that can write ────────────────────────────────────
  const manifest = await readArchiveManifest(archive);
  say(`backup taken ${manifest.createdAt} by ${manifest.product.name} ${manifest.product.version}`);
  say(
    `  ${manifest.counts.projects} project(s), ${manifest.counts.documents} document(s), ${manifest.counts.chunks} chunk(s), ` +
      `${manifest.counts.uploadSources} upload tree(s)`,
  );
  say(`  from PostgreSQL ${manifest.database.serverVersion} (${manifest.database.mode})`);
  say(topology.notice);

  let key = checkSecretKey(manifest, secretKey);
  if (!key.ok && countsNonCredentialSecrets(manifest, CREDENTIAL_SOURCE_TYPES)) {
    // An archive from before ADR-0091 counted a secret on every source type. Judge it on its rows.
    const found = await secretsInDump(tools, archive);
    if (found) {
      say(
        `  this backup predates per-type secret counts; its dump holds ${found.credential} git, Notion or Confluence ` +
          `credential(s) and ${found.other} secret(s) on local, upload or web sources, which a restore drops.`,
      );
      key = checkSecretKey({ ...manifest, secretKey: { ...manifest.secretKey, encryptedSources: found.credential } }, secretKey);
    }
  }
  if (!key.ok) throw new BackupRefused(key.code, key.message);
  if (key.note) say(`  note: ${key.note}`);

  await tools.version('pg_restore');
  const into = await serverVersion(db);
  const version = checkServerVersion(manifest, into);
  if (!version.ok) throw new BackupRefused(version.code, version.message);
  if (version.note) say(`  note: ${version.note}`);

  for (const upload of manifest.uploads) {
    if (!UPLOAD_PATH_RE.test(upload.path)) {
      throw new BackupRefused(
        'unreadable_manifest',
        `This backup's manifest names an upload tree at "${upload.path}", which is not a path this product writes. ` + 'Nothing has been written.',
      );
    }
  }

  if (opts.check) {
    say('');
    say('--check: every refusal was evaluated and this archive passed them. Nothing was written.');
    say(`  a real run would replace the database "${tools.database}" and ${manifest.uploads.length} upload tree(s) under ${config.DATA_DIR}.`);
    return { manifest, checkedOnly: true, uploadsRestored: 0, droppedSecrets: 0 };
  }

  // ── Unpacked, and checked again — still before anything is written ────────────────────────────────
  say('');
  say(`restoring into "${tools.database}" — this replaces what is there now.`);
  // Emptied first, because what gets put back has to come from **this** archive. A staging directory
  // that still held the previous restore's `data/` would let a later, truncated archive pass the
  // check below on somebody else's bytes — and then write them over the live tree. `main()` names a
  // fresh directory per run, so this is belt and braces there; it is the whole guarantee for any
  // caller that reuses one, the integration suite included.
  await fs.rm(tools.scratch.local, { recursive: true, force: true });
  await fs.mkdir(tools.scratch.local, { recursive: true });
  await tar.extract({ file: archive, cwd: tools.scratch.local, filter: permitted });

  /**
   * **The manifest is a claim about bytes, and this is where the bytes answer.**
   *
   * Each upload tree is restored by removing the one on disk and putting the carried one in its
   * place. A manifest naming a tree the archive does not actually contain — a truncated download, an
   * archive somebody edited, an entry the `permitted` filter dropped — would therefore *delete* that
   * source's files and then die on the copy, with `pg_restore --clean` already behind it. So every
   * tree is required to be here before the first one is removed, and this check sits before the
   * database is touched rather than beside the removal it protects: a refusal at this line costs
   * nothing at all, and the same refusal one step later costs a corpus.
   *
   * [ADR-0051](../.ssot/ADR.md#adr-0051) learned this in the other direction — its import checks the
   * dimension again per chunk *while reading*, because a manifest is a claim — and had to add a
   * compensating unwind for what that leaves behind. There is nothing to unwind here if the check is
   * made first.
   */
  for (const upload of manifest.uploads) {
    const carried = path.join(tools.scratch.local, DATA_PREFIX, upload.path);
    const found = await fs.stat(carried).catch(() => null);
    if (!found?.isDirectory()) {
      throw new BackupRefused(
        'incomplete_archive',
        `This backup's manifest lists an upload tree for "${upload.project} / ${upload.source}" ` +
          `(${upload.files} file(s)), and the archive does not contain it. Restoring would delete that source's ` +
          'files here and have nothing to put back. The archive is truncated or was edited. Nothing has been written.',
      );
    }
  }

  const dumpRemote = path.join(tools.scratch.remote, DATABASE_ENTRY);
  // ADR-0046's command, unchanged and for its reasons: `--clean --if-exists` is what lets one command
  // serve an empty database and a populated one, and `--no-owner` is still not passed.
  await tools.run('pg_restore', ['--clean', '--if-exists', '-d', tools.database, dumpRemote]);
  say('  database restored.');

  // ADR-0091: a secret on a type that uses none is dropped, and said so. The API has refused to store
  // one since the same decision; this is what clears the ones an older instance kept.
  const dropped = await db
    .update(documentSources)
    .set({ secretEnc: null })
    // Every type outside the credential list — today `local`, `upload` and `web`.
    .where(and(notInArray(documentSources.type, [...CREDENTIAL_SOURCE_TYPES]), isNotNull(documentSources.secretEnc)))
    .returning({ id: documentSources.id });
  say(`  ${dropped.length} secret(s) on local, upload or web sources dropped — those types use no credential (ADR-0091).`);

  let uploadsRestored = 0;
  for (const upload of manifest.uploads) {
    const from = path.join(tools.scratch.local, DATA_PREFIX, upload.path);
    const to = path.join(config.DATA_DIR, upload.path);
    // Belt and braces over the regex above: the joined path has to stay inside DATA_DIR.
    if (path.relative(config.DATA_DIR, to).startsWith('..')) {
      throw new BackupRefused('unreadable_manifest', `An upload tree in this backup resolves outside DATA_DIR: ${upload.path}`);
    }
    await fs.rm(to, { recursive: true, force: true });
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true });
    uploadsRestored++;
    say(`  ${upload.project} / ${upload.source} — ${upload.files} file(s) restored to ${to}`);
  }

  say('');
  say('Restart the application so it re-opens its pool and re-reads settings against the database it now has.');
  if (manifest.secretKey.present) {
    say(`SECRET_KEY was checked against this backup's fingerprint (${manifest.secretKey.fingerprint}) before anything was written.`);
  }
  return { manifest, checkedOnly: false, uploadsRestored, droppedSecrets: dropped.length };
}

async function main(): Promise<void> {
  await import('dotenv/config');
  useEmbeddedDatabaseWhenNothingElseSays();

  const args = parseRestoreArgs(process.argv.slice(2));
  if (args.help || !args.reference) {
    console.error('Usage: npm run restore -- <file.tar.gz> [--check]');
    console.error('       npm run restore -- --s3 <archive-name|latest> [--check]');
    console.error("  Replaces this instance's database and upload trees with what is in the archive.");
    console.error('  --s3 fetches the archive from the bucket named by BACKUP_S3_* first; "latest" is the newest timestamped one.');
    console.error('  --check reads the manifest, evaluates every refusal and writes nothing to the database or the upload trees.');
    process.exit(2);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    await runRestoreCommand(args, {
      db,
      config,
      env: process.env,
      tools: (staging) => localPgTools(staging, connectionFromEnv()),
      topology: describeTopology(),
      secretKey: config.SECRET_KEY,
      say: (line) => console.log(line),
    });
  } finally {
    await pool.end();
  }
}

export interface RestoreCommandDeps extends Omit<RestoreDeps, 'tools'> {
  /** `BACKUP_S3_*` is read from here, never from `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Given the staging directory this run names, so the real command and a test can scratch in different places. */
  tools: (staging: string) => PgTools;
}

/**
 * What `npm run restore` does once its arguments are parsed and its connections are open — the part
 * `--s3` changes, apart from `main` so an integration test can drive the wiring an operator runs
 * (flag → env → download → the same refusals as a local file) and not only the pieces.
 */
export async function runRestoreCommand(args: RestoreArgs, deps: RestoreCommandDeps): Promise<RestoreResult> {
  const { config, env, say } = deps;
  if (!args.reference) throw new BackupRefused('usage', 'Name the archive to restore.');
  // Refused before anything is opened: a missing credential should not wait behind a connection.
  const s3 = args.s3 ? new S3Client(s3TargetFromEnv(env)) : undefined;
  // Named rather than created: `runRestore` makes it when it reaches the unpacking, so a `--check`
  // run leaves no directory behind either. "Nothing was written." has to be true of the filesystem
  // and not only of the database.
  const staging = path.join(config.DATA_DIR, `${STAGING}-${randomUUID()}`);
  // A sibling of `staging`, never inside it: `runRestore` empties its scratch directory before it
  // unpacks, and the archive it is about to read must not be in the way of that. With `--s3` a
  // `--check` still needs the bytes on disk to read the manifest, so the one thing it writes is this
  // download, removed below whatever happens.
  const download = path.join(config.DATA_DIR, `${STAGING}-download-${randomUUID()}`);
  try {
    const archive = s3 ? await fetchArchive(s3, args.reference, download, say) : args.reference;
    return await runRestore({ ...deps, tools: deps.tools(staging) }, archive, { check: args.check });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(download, { recursive: true, force: true });
  }
}

export interface RestoreArgs {
  help: boolean;
  check: boolean;
  s3: boolean;
  /** The archive file, or with `--s3` an archive name under the prefix or `latest`. */
  reference?: string;
}

export function parseRestoreArgs(argv: string[]): RestoreArgs {
  const result: RestoreArgs = { help: false, check: false, s3: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--check') result.check = true;
    else if (arg === '--s3') result.s3 = true;
    else if (arg.startsWith('-'))
      throw new BackupRefused('usage', `Unknown option ${arg}. Usage: npm run restore -- <file.tar.gz> [--check] | --s3 <name|latest>`);
    else if (result.reference !== undefined) throw new BackupRefused('usage', 'Name exactly one archive.');
    else result.reference = arg;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    if (err instanceof BackupRefused) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
}
