import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import * as tar from 'tar';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import {
  BackupRefused,
  checkSecretKey,
  checkServerVersion,
  connectionFromEnv,
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

  const key = checkSecretKey(manifest, secretKey);
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
    return { manifest, checkedOnly: true, uploadsRestored: 0 };
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
  return { manifest, checkedOnly: false, uploadsRestored };
}

async function main(): Promise<void> {
  await import('dotenv/config');
  useEmbeddedDatabaseWhenNothingElseSays();

  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const archive = args.find((arg) => !arg.startsWith('-'));
  if (!archive) {
    console.error('Usage: npm run restore -- <file.tar.gz> [--check]');
    console.error("  Replaces this instance's database and upload trees with what is in the archive.");
    console.error('  --check reads the manifest, evaluates every refusal and writes nothing.');
    process.exit(2);
  }

  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  // Named rather than created: `runRestore` makes it when it reaches the unpacking, so a `--check`
  // run leaves no directory behind either. "Nothing was written." has to be true of the filesystem
  // and not only of the database.
  const staging = path.join(config.DATA_DIR, `${STAGING}-${randomUUID()}`);
  try {
    await runRestore(
      {
        db,
        config,
        tools: localPgTools(staging, connectionFromEnv()),
        topology: describeTopology(),
        secretKey: config.SECRET_KEY,
        say: (line) => console.log(line),
      },
      archive,
      { check },
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await pool.end();
  }
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
