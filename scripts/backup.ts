import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import * as tar from 'tar';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { documentSources } from '../src/db/schema.js';
import { encryptedRowFilter } from '../src/services/encrypted-fields.js';
import {
  BackupRefused,
  connectionFromEnv,
  DATABASE_ENTRY,
  DATA_PREFIX,
  describeTopology,
  localPgTools,
  MANIFEST_ENTRY,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  measureTree,
  README_ENTRY,
  readmeFor,
  secretKeyFingerprint,
  type Manifest,
  type PgTools,
  type Topology,
} from './backup-archive.js';
import { useEmbeddedDatabaseWhenNothingElseSays } from './embedded-database.js';
import { APP_NAME, APP_VERSION } from '../src/version.js';

/**
 * `npm run backup -- <file.tar.gz>` — one command that takes the backup this installation actually
 * needs ([ADR-0072](../.ssot/ADR.md#adr-0072)).
 *
 * It runs inside the shipped container, for [ADR-0032](../.ssot/ADR.md#adr-0032)'s reason and
 * [ADR-0046](../.ssot/ADR.md#adr-0046)'s: the embedded PostgreSQL listens on the container's own
 * loopback and is published nowhere, and `pg_dump` ships beside it at the version that matches it. The
 * image already carries `scripts/`, `src/`, `npm` and `tsx` so that `reset-password` can run there;
 * this needs nothing new.
 *
 * **What it produces is three things and a statement about a fourth.** The database, the upload trees
 * that exist nowhere else, a manifest read before anything else — and the record that `SECRET_KEY` was
 * set, which is not the same as the key and is deliberately not it.
 */

/** Where the archive is assembled before it is one file. A sibling of `projects/`, like `.transfer`. */
const STAGING = '.backup';

export interface BackupDeps {
  db: Db;
  config: Config;
  tools: PgTools;
  topology: Topology;
  /** What the command says as it goes. The integration suite captures it; `main` prints it. */
  say: (line: string) => void;
}

export interface BackupResult {
  manifest: Manifest;
  /** The archive, where it was asked for. */
  file: string;
  bytes: number;
}

interface UploadSource {
  projectId: string;
  project: string;
  sourceId: string;
  source: string;
}

/** Every `upload` source, which is the one type whose materialised files exist nowhere else. */
async function uploadSources(db: Db): Promise<UploadSource[]> {
  const result = await db.execute(sql`
    SELECT p.id AS project_id, p.name AS project, s.id AS source_id, s.name AS source
    FROM document_sources s JOIN projects p ON p.id = s.project_id
    WHERE s.type = 'upload' ORDER BY p.name, s.name`);
  return (result.rows as Array<{ project_id: string; project: string; source_id: string; source: string }>).map((row) => ({
    projectId: row.project_id,
    project: row.project,
    sourceId: row.source_id,
    source: row.source,
  }));
}

/**
 * The two secret counts are counted apart on purpose ([ADR-0075](../../.ssot/ADR.md#adr-0075)).
 *
 * `encryptedSources` stays what Faz 09 made it: rows the wrong key would destroy — a sync credential
 * the provider issued and this instance cannot reissue. That number, and only that number, is what
 * makes `checkSecretKey` refuse. `regenerableSecrets` is the second kind: webhook secrets, which this
 * instance generates and can generate again. Counting both in one number would mean a single public
 * repository with a webhook stops a restore that costs nothing, which is the case Faz 09 went out of
 * its way to let through.
 */
async function counts(
  db: Db,
): Promise<{ projects: number; documents: number; chunks: number; encryptedSources: number; regenerableSecrets: number }> {
  const result = await db.execute(sql`
    SELECT (SELECT count(*)::int FROM projects) AS projects,
           (SELECT count(*)::int FROM documents) AS documents,
           (SELECT count(*)::int FROM chunks) AS chunks,
           (SELECT count(*)::int FROM document_sources WHERE ${encryptedRowFilter(documentSources, 'irrecoverable')}) AS encrypted_sources,
           (SELECT count(*)::int FROM document_sources WHERE ${encryptedRowFilter(documentSources, 'regenerable')}) AS regenerable_secrets`);
  const row = result.rows[0] as {
    projects: number;
    documents: number;
    chunks: number;
    encrypted_sources: number;
    regenerable_secrets: number;
  };
  return {
    projects: row.projects,
    documents: row.documents,
    chunks: row.chunks,
    encryptedSources: row.encrypted_sources,
    regenerableSecrets: row.regenerable_secrets,
  };
}

async function schemaFacts(db: Db): Promise<{ version: string; migrations: number }> {
  const version = await db.execute(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
  const journal = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
  return {
    version: (version.rows[0] as { value: string } | undefined)?.value ?? 'unknown',
    migrations: (journal.rows[0] as { n: number } | undefined)?.n ?? 0,
  };
}

async function serverVersion(db: Db): Promise<string> {
  const result = await db.execute(sql`SHOW server_version`);
  return (result.rows[0] as { server_version: string } | undefined)?.server_version ?? 'unknown';
}

/**
 * Takes the backup into `outPath`.
 *
 * The order is the order the refusals want: the tools are checked before a byte is read, the dump is
 * taken before the trees are copied (it is the long half, and a failure in it should not have cost a
 * corpus copy first), and the manifest is written last because it reports on both.
 */
export async function runBackup(deps: BackupDeps, outPath: string): Promise<BackupResult> {
  const { db, config, tools, topology, say } = deps;

  say(topology.notice);
  const dumpToolVersion = await tools.version('pg_dump');

  await fs.mkdir(tools.scratch.local, { recursive: true });
  const dump = { local: path.join(tools.scratch.local, DATABASE_ENTRY), remote: path.join(tools.scratch.remote, DATABASE_ENTRY) };

  // ── The database, with ADR-0046's flags and no others ─────────────────────────────────────────────
  // `-Fc`, and nothing else. `--no-owner` is still deliberately not passed, for the reason ADR-0046
  // gives: there is one role in this installation and it is the role the dump is taken as. What this
  // command adds is not a different dump, it is the two things that were never in one.
  say('taking the database dump…');
  await tools.run('pg_dump', ['-Fc', '-f', dump.remote]);
  const databaseDumpBytes = (await fs.stat(dump.local)).size;
  say(`  ${DATABASE_ENTRY} — ${describeBytes(databaseDumpBytes)}`);

  // ── The upload trees, and only those ──────────────────────────────────────────────────────────────
  // ADR-0046's own classification of DATA_DIR decides this and nothing here re-decides it: a git
  // `repo/` is re-clonable, a Notion `current/` is re-pullable, `.staging/` is disposable by
  // construction, and an upload `current/` is the only copy of its content anywhere. Copying the
  // re-clonable half every night is the cost that makes people stop taking backups.
  const sources = await uploadSources(db);
  const uploads: Manifest['uploads'] = [];
  for (const source of sources) {
    const relative = path.posix.join('projects', source.projectId, 'sources', source.sourceId, 'current');
    const from = path.join(config.DATA_DIR, relative);
    const measured = await measureTree(from);
    if (measured.files === 0) {
      say(`  ${source.project} / ${source.source} — no files on disk; nothing to carry`);
      continue;
    }
    await fs.mkdir(path.dirname(path.join(tools.scratch.local, DATA_PREFIX, relative)), { recursive: true });
    await fs.cp(from, path.join(tools.scratch.local, DATA_PREFIX, relative), { recursive: true });
    uploads.push({ project: source.project, source: source.source, path: relative, files: measured.files, bytes: measured.bytes });
    say(`  ${DATA_PREFIX}/${relative} — ${measured.files} file(s), ${describeBytes(measured.bytes)} (${source.project} / ${source.source})`);
  }

  // ── The manifest, and the key that is not in it ───────────────────────────────────────────────────
  const tally = await counts(db);
  const manifest: Manifest = {
    kind: MANIFEST_KIND,
    manifestVersion: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    product: { name: APP_NAME, version: APP_VERSION },
    database: {
      mode: topology.mode,
      target: topology.target,
      serverVersion: await serverVersion(db),
      dumpToolVersion,
    },
    schema: await schemaFacts(db),
    secretKey: {
      present: Boolean(config.SECRET_KEY),
      fingerprint: config.SECRET_KEY ? secretKeyFingerprint(config.SECRET_KEY) : null,
      encryptedSources: tally.encryptedSources,
      regenerableSecrets: tally.regenerableSecrets,
    },
    counts: {
      projects: tally.projects,
      documents: tally.documents,
      chunks: tally.chunks,
      uploadSources: uploads.length,
      uploadFiles: uploads.reduce((n, u) => n + u.files, 0),
      uploadBytes: uploads.reduce((n, u) => n + u.bytes, 0),
      databaseDumpBytes,
    },
    uploads,
  };

  await fs.writeFile(path.join(tools.scratch.local, MANIFEST_ENTRY), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(tools.scratch.local, README_ENTRY), readmeFor(manifest), 'utf8');

  // The manifest is the first entry, which is what lets `restore` decide every refusal from a few
  // hundred bytes of a file that is gigabytes. `tar.create` writes the list in the order given.
  const entries = [MANIFEST_ENTRY, README_ENTRY, DATABASE_ENTRY];
  if (uploads.length > 0) entries.push(DATA_PREFIX);
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await tar.create({ gzip: true, file: path.resolve(outPath), cwd: tools.scratch.local, portable: true }, entries);
  const bytes = (await fs.stat(path.resolve(outPath))).size;

  say('');
  say(`  ${path.resolve(outPath)} — ${describeBytes(bytes)}`);
  say(`  ${tally.projects} project(s), ${tally.documents} document(s), ${tally.chunks} chunk(s), ${uploads.length} upload tree(s)`);
  say('');
  for (const line of secretKeySentences(manifest)) say(line);

  return { manifest, file: path.resolve(outPath), bytes };
}

/**
 * The part of the output that is the reason this command exists, printed every time and never only
 * when something is wrong. An operator who reads nothing else has to come away knowing that this file
 * is not sufficient on its own.
 */
export function secretKeySentences(manifest: Manifest): string[] {
  if (!manifest.secretKey.present) {
    return [
      '  SECRET_KEY: this instance has none set, so nothing in this backup is encrypted under one.',
      '  Set one before adding a private git repository or a Notion integration, and this line will change.',
    ];
  }
  const { encryptedSources, regenerableSecrets, fingerprint } = manifest.secretKey;
  return [
    `  SECRET_KEY is NOT in this file and never will be — only its fingerprint, ${fingerprint}.`,
    `  ${encryptedSources} source(s) in the dump hold a sync credential encrypted under it — the token the provider` +
      ' issued, which this instance cannot reissue. A restore without that exact key cannot decrypt any of them, and' +
      ' `restore` will refuse to start rather than leave you to find out.',
    `  ${regenerableSecrets} source(s) hold a webhook secret encrypted under it. Those a restore does not stop for.` +
      ' For a git source, regenerate the secret here and paste the new one into the repository; for a Notion source,' +
      ' open a fresh verification window and re-verify from Notion.',
    '  Keep the key where this archive is not. The two together are the whole instance.',
  ];
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Where the archive goes when the operator names no file.
 *
 * `DATA_DIR/backups`, and **never the working directory**. Inside the container the working directory
 * is `/app`, which is an image layer: an archive written there is not on a volume, it is gone the next
 * time the container is recreated, and the person who finds that out is the person who went looking
 * for the backup. `backups/` is a sibling of `projects/`, so the orphan sweep does not see it and the
 * next backup — which carries only `projects/<id>/sources/<id>/current` — does not carry it.
 */
export function archiveDestination(requested: string | undefined, config: Pick<Config, 'DATA_DIR'>, now: Date = new Date()): string {
  return requested ?? path.join(config.DATA_DIR, 'backups', defaultArchiveName(now));
}

/** `contextator-backup-2026-09-22T12-00-00Z.tar.gz`, when the operator names no file. */
export function defaultArchiveName(now: Date = new Date()): string {
  return `contextator-backup-${now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z')}.tar.gz`;
}

async function main(): Promise<void> {
  // Imported here rather than at the top: a test importing `runBackup` must not have this file
  // rewrite its environment on the way in.
  await import('dotenv/config');
  // Inside the shipped container this is what makes `docker exec … npm run backup` able to find the
  // database at all; everywhere else it is a no-op. See `embedded-database.ts`.
  useEmbeddedDatabaseWhenNothingElseSays();

  const requested = process.argv[2];
  if (requested === '--help' || requested === '-h') {
    console.error('Usage: npm run backup -- [file.tar.gz]');
    console.error('  Writes the database, the upload trees and a manifest into one archive.');
    console.error('  Without a path, writes it under <DATA_DIR>/backups/, which is a volume.');
    console.error('  SECRET_KEY is never written into it; keep it separately.');
    process.exit(2);
  }

  const config = loadConfig();
  const out = archiveDestination(requested, config);
  const { db, pool } = createDb(config.DATABASE_URL);
  await fs.mkdir(config.DATA_DIR, { recursive: true });
  const staging = await fs.mkdtemp(path.join(config.DATA_DIR, `${STAGING}-`));
  try {
    await runBackup(
      {
        db,
        config,
        tools: localPgTools(staging, connectionFromEnv()),
        topology: describeTopology(),
        say: (line) => console.log(line),
      },
      out,
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await pool.end();
  }
}

/** Only when this file *is* the command; importing it from a test must not back anything up. */
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
