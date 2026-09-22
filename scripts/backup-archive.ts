import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import { z } from 'zod';

/**
 * The shape of an instance backup, and every refusal that is decided from its manifest
 * ([ADR-0072](../.ssot/ADR.md#adr-0072)).
 *
 * **Why there is a wrapper at all, when [ADR-0046](../.ssot/ADR.md#adr-0046) refused one.** That entry
 * rejected `scripts/backup.sh` because a four-line script would hide the two `pg_dump` flags that are
 * the decision — and it was right about the script it was refusing. What it also wrote down, in its own
 * consequences, is the reason this file exists: **a dump is not the installation.** It carries no
 * `SECRET_KEY`, so every stored source credential comes back undecryptable, and it carries nothing from
 * `DATA_DIR`, so an upload source — the one source type whose files exist nowhere else — comes back
 * configured and permanently empty. An operator who knows both takes the right backup by hand. An
 * operator who does not learns it on the morning the dump is all they have. A document can state the
 * difference; a command can *make* it.
 *
 * So this is not a wrapper around two flags. It is the three artefacts a restore needs, in one file,
 * with a manifest that says what the file is and what it deliberately is not.
 *
 * **`SECRET_KEY` is not one of them, and that is the whole point.** Writing the key into the archive
 * would turn the backup into the thing the encryption exists to prevent — one file that is the entire
 * instance, sitting on a backup volume with a weaker access story than the environment it came from.
 * What travels instead is a *key check value*: 128 bits of HMAC-SHA-256, keyed by the secret, over a
 * fixed label. It proves which key a restore needs without being that key, and it is what lets
 * `restore` refuse a wrong or missing key **before it writes anything** rather than after a half-loaded
 * instance exists.
 */

/** Bumped when a field changes meaning, not when one is added. */
export const MANIFEST_VERSION = 1;

/** What the tarball claims to be. A file that does not say this is not one of ours, whatever its name. */
export const MANIFEST_KIND = 'contextator.instance-backup';

/** The first entry in the archive, so a refusal costs one small read rather than a corpus's worth. */
export const MANIFEST_ENTRY = 'manifest.json';
/** The prose half of the manifest, for the operator who opens the tarball rather than the tool. */
export const README_ENTRY = 'README.txt';
/** `pg_dump -Fc` of the whole database, exactly as ADR-0046's documented command produces it. */
export const DATABASE_ENTRY = 'database.dump';
/** Upload sources' materialised trees, under their own `DATA_DIR`-relative paths. */
export const DATA_PREFIX = 'data';

/** A manifest larger than this is not one. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * The label the key check value is computed over. It is fixed and public: the secrecy is the key's,
 * and a per-archive salt would only stop two archives taken under the same key from being *recognised*
 * as such — which is a property this file wants rather than one it is defending against, because it is
 * how an operator can tell which of last year's backups their current key still opens.
 */
export const FINGERPRINT_LABEL = 'contextator.backup.secret-key.v1';

/**
 * A key check value for `SECRET_KEY` — HMAC-SHA-256 keyed by the secret, truncated to 128 bits.
 *
 * Keyed by the secret rather than hashing it: a bare `sha256(key)` is an offline verifier that lets
 * whoever holds the archive test candidate keys at the speed of one hash, and while `SECRET_KEY` is a
 * 32-character minimum, "minimum" is not "random". An HMAC over a constant is the standard shape for
 * this and gives nothing else away; 128 bits is far past the point where two different keys collide.
 */
export function secretKeyFingerprint(secretKey: string): string {
  return createHmac('sha256', secretKey).update(FINGERPRINT_LABEL).digest('hex').slice(0, 32);
}

const Manifest = z.object({
  kind: z.literal(MANIFEST_KIND),
  manifestVersion: z.number().int().min(1),
  createdAt: z.string().min(1).max(64),
  product: z.object({ name: z.string().max(200), version: z.string().max(200) }),
  /** Which topology the backup was taken from, and against which server — never with the credential. */
  database: z.object({
    mode: z.enum(['embedded', 'external']),
    /** `host:port/database`, or `null` for a connection string this product will not guess at. */
    target: z.string().max(2048).nullable(),
    /** What the server said it was, because a major version is what decides where this can be restored. */
    serverVersion: z.string().max(200),
    /** And what took the dump, because a client older than the server cannot be relied on to. */
    dumpToolVersion: z.string().max(200),
  }),
  /** How far the source instance's schema had come ([ADR-0033](../.ssot/ADR.md#adr-0033)). */
  schema: z.object({ version: z.string().max(64), migrations: z.number().int().min(0) }),
  /**
   * The key, described rather than carried.
   *
   * `encryptedSources` is the number of rows in the dump that cannot be read without it, and it is
   * what makes the refusal in `checkSecretKey` a statement about the data rather than about a setting.
   */
  secretKey: z.object({
    present: z.boolean(),
    fingerprint: z.string().max(64).nullable(),
    encryptedSources: z.number().int().min(0),
  }),
  counts: z.object({
    projects: z.number().int().min(0),
    documents: z.number().int().min(0),
    chunks: z.number().int().min(0),
    uploadSources: z.number().int().min(0),
    uploadFiles: z.number().int().min(0),
    uploadBytes: z.number().int().min(0),
    databaseDumpBytes: z.number().int().min(0),
  }),
  /**
   * The upload trees inside this archive, named the way an operator can find them again: the project,
   * the source, and the path under `DATA_DIR` the restore will put them back at.
   */
  uploads: z.array(
    z.object({
      project: z.string().max(200),
      source: z.string().max(200),
      path: z.string().max(4096),
      files: z.number().int().min(0),
      bytes: z.number().int().min(0),
    }),
  ),
});

export type Manifest = z.infer<typeof Manifest>;

/**
 * Every refusal this feature makes, as one error type carrying a code.
 *
 * A code and not only a message because the codes are what the integration suite asserts on: a test
 * that matched the prose would pass or fail on a reworded sentence, and these sentences are meant to
 * be reworded whenever an operator reads one and is still unsure what to do.
 */
export class BackupRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackupRefused';
  }
}

/** Parses the manifest and refuses anything this build has no business reading. */
export function parseManifest(raw: unknown): Manifest {
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind !== undefined && kind !== MANIFEST_KIND) {
      throw new BackupRefused(
        'not_a_backup',
        `This file says it is "${String(kind)}". A Contextator instance backup says "${MANIFEST_KIND}". ` +
          'A single project moves with the export/import route instead (OPERATIONS.md §4.9).',
      );
    }
    const version = (raw as { manifestVersion?: unknown } | null)?.manifestVersion;
    if (typeof version === 'number' && version > MANIFEST_VERSION) {
      throw new BackupRefused(
        'manifest_too_new',
        `This backup is in manifest format ${version}; this build reads ${MANIFEST_VERSION}. Restore it with the release that wrote it.`,
      );
    }
    throw new BackupRefused('unreadable_manifest', `The manifest in this archive could not be read: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.manifestVersion > MANIFEST_VERSION) {
    throw new BackupRefused(
      'manifest_too_new',
      `This backup is in manifest format ${parsed.data.manifestVersion}; this build reads ${MANIFEST_VERSION}. ` +
        'Restore it with the release that wrote it.',
    );
  }
  return parsed.data;
}

export type SecretKeyVerdict = { ok: true; note: string | null } | { ok: false; code: 'secret_key_missing' | 'secret_key_mismatch'; message: string };

/**
 * Whether this environment holds the key this backup was taken under — decided **before** a byte of it
 * is unpacked, which is the difference between a refusal and a half-restored instance.
 *
 * **The refusal is about the ciphertext, not about the setting.** `encryptedSources` counts the rows
 * in the dump that cannot be read without the key. When it is zero there is nothing for a wrong key to
 * cost: an instance whose sources are all public git repositories, local directories and uploads has
 * no encrypted column at all, and refusing its restore would be refusing the one case that is
 * unambiguously safe. It is still *said*, because a key that changed silently is a key nobody notices
 * has changed until the first private source is added. When it is not zero, a wrong key means every
 * one of those sources comes back with a token that will never decrypt — which is a restore that
 * looks like it worked and has to be done again — so it stops.
 */
export function checkSecretKey(manifest: Manifest, secretKey: string | undefined): SecretKeyVerdict {
  const { present, fingerprint, encryptedSources } = manifest.secretKey;
  const atStake =
    `${encryptedSources} source${encryptedSources === 1 ? '' : 's'} in this backup ` +
    `${encryptedSources === 1 ? 'holds a credential' : 'hold credentials'} encrypted under it`;

  if (!present || !fingerprint) {
    if (secretKey) {
      return { ok: true, note: 'This backup was taken from an instance with no SECRET_KEY set, so nothing in it is encrypted under one.' };
    }
    return { ok: true, note: null };
  }

  if (!secretKey) {
    if (encryptedSources === 0) {
      return {
        ok: true,
        note:
          'This backup was taken under a SECRET_KEY and this environment has none. Nothing in it is encrypted ' +
          '(no source held a credential), so the restore is complete — but set the key before adding a private source.',
      };
    }
    return {
      ok: false,
      code: 'secret_key_missing',
      message:
        `This backup was taken from an instance with a SECRET_KEY, and ${atStake}. ` +
        'SECRET_KEY is not in the archive and never will be: a backup that carried it would be the whole instance in one file. ' +
        `Set SECRET_KEY to the value that instance used (fingerprint ${fingerprint}) and run this again. ` +
        'Nothing has been written.',
    };
  }

  if (secretKeyFingerprint(secretKey) !== fingerprint) {
    if (encryptedSources === 0) {
      return {
        ok: true,
        note:
          'The SECRET_KEY in this environment is not the one this backup was taken under. Nothing in it is encrypted ' +
          '(no source held a credential), so the restore is complete — but any credential entered before this backup would not have survived.',
      };
    }
    return {
      ok: false,
      code: 'secret_key_mismatch',
      message:
        `The SECRET_KEY in this environment is not the one this backup was taken under, and ${atStake}. ` +
        `The backup needs the key whose fingerprint is ${fingerprint}; this environment's is ${secretKeyFingerprint(secretKey)}. ` +
        'Restoring anyway would put back credentials that can never be decrypted, and each one would have to be re-entered by hand. ' +
        'Nothing has been written.',
    };
  }

  return { ok: true, note: null };
}

export type DatabaseMode = 'embedded' | 'external';

export interface Topology {
  mode: DatabaseMode;
  /** `host:port/database`, never the credential. `null` when the value is not a URL this can read. */
  target: string | null;
  /** What the command is about to do, in the operator's terms. Printed, and never only logged. */
  notice: string;
}

/**
 * Which database this command is about to talk to, and what that means for whose job the backup is.
 *
 * It is read off `DATABASE_URL` and nothing else, because that is exactly what `docker/entrypoint.sh`
 * decides the topology on ([ADR-0069](../.ssot/ADR.md#adr-0069)): unset means the PostgreSQL inside
 * this container, set means a server somebody else operates. The distinction is not cosmetic. On the
 * external topology this command is reaching across a network at a database whose backups may already
 * be covered by an infrastructure nobody here can see, and it will be taking a **logical** dump of it
 * with whatever `pg_dump` happens to be on this image — so it says both rather than quietly producing
 * a second, unmanaged copy of somebody's production data.
 */
export function describeTopology(env: NodeJS.ProcessEnv = process.env): Topology {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return {
      mode: 'embedded',
      target: null,
      notice: 'database: embedded — the PostgreSQL inside this container. This backup is the whole of it.',
    };
  }
  const target = redactUrl(url);
  return {
    mode: 'external',
    target,
    notice:
      `database: external — ${target ?? 'the server named in DATABASE_URL'}. ` +
      'Nothing in this image operates that server: if it already has a backup regime, this archive is a second, ' +
      'unmanaged copy of the same data and the schedule that matters is not this one. ' +
      'What this image is the only source of either way is the upload trees under DATA_DIR, which are in here too.',
  };
}

/** `postgres://user:secret@db:5432/contextator` → `db:5432/contextator`. Never the userinfo. */
export function redactUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname) return null;
    const port = url.port ? `:${url.port}` : '';
    return `${url.hostname}${port}${url.pathname}`;
  } catch {
    // A libpq keyword/value string (`host=… dbname=…`) parses as no URL. `null` rather than a guess:
    // a target printed wrongly is worse than one not printed, because it reads as checked.
    return null;
  }
}

/**
 * The two PostgreSQL client programs, and where they can write a file this process can also read.
 *
 * **This is an interface because of where the tools have to run**, which is the one thing
 * [ADR-0046](../.ssot/ADR.md#adr-0046) settled and this change does not reopen: `pg_dump` and
 * `pg_restore` ship beside the server in the image and are the versions that match it, and a backup
 * taken with whatever a developer's package manager last installed is a test of that laptop. In the
 * container the operator runs this in, the tools are simply on the `PATH` — `localPgTools` is that,
 * and it is what every real invocation uses. The integration suite implements the same two methods
 * against the harness's container, so the suite exercises this file's own logic with the tools where
 * ADR-0046 put them rather than a re-statement of it.
 */
export type PgTool = 'pg_dump' | 'pg_restore';

export interface PgTools {
  /**
   * A directory both sides can see: `local` as this process sees it, `remote` as the tools do. They
   * are the same path in every real invocation and differ only where the tools are somewhere else,
   * which is the integration suite's container.
   */
  scratch: { local: string; remote: string };
  /** The database the tools address. `pg_restore` takes it as `-d` and has no environment default. */
  database: string;
  run(tool: PgTool, args: string[]): Promise<string>;
  /** `<tool> --version`, or a refusal naming the tool and the image that has it. */
  version(tool: PgTool): Promise<string>;
}

/**
 * How libpq is told where the database is.
 *
 * `DATABASE_URL` is taken apart into the `PG*` variables rather than handed to the tools as an
 * argument, because an argument is visible in `ps` to everything else in the container and a password
 * is exactly what would be in it. Unset, nothing is added at all: the entrypoint has already put the
 * embedded cluster's `PG*` variables in this process's environment, and a second opinion about them
 * here is a second place for them to be wrong.
 */
export interface PgConnection {
  env: Record<string, string>;
  database: string;
}

export function connectionFromEnv(env: NodeJS.ProcessEnv = process.env): PgConnection {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return { env: {}, database: env.PGDATABASE ?? env.POSTGRES_DB ?? 'contextator' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BackupRefused(
      'unreadable_database_url',
      'DATABASE_URL is not a URL this command can take apart, so it cannot tell pg_dump where the database is ' +
        'without putting the whole string — password included — into a command line. Write it as ' +
        'postgres://user:password@host:5432/database, or run the tools against that server yourself.',
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'contextator';
  const vars: Record<string, string> = { PGDATABASE: database };
  if (parsed.hostname) vars.PGHOST = decodeURIComponent(parsed.hostname);
  if (parsed.port) vars.PGPORT = parsed.port;
  if (parsed.username) vars.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) vars.PGPASSWORD = decodeURIComponent(parsed.password);
  return { env: vars, database };
}

/** The tools on this process's own `PATH`, writing into `dir`. What the operator's invocation uses. */
export function localPgTools(dir: string, connection: PgConnection): PgTools {
  const environment = { ...process.env, ...connection.env };
  return {
    scratch: { local: dir, remote: dir },
    database: connection.database,
    run: (tool, args) => runLocal(tool, args, environment),
    version: async (tool) => {
      try {
        return (await runLocal(tool, ['--version'], environment)).trim();
      } catch (err) {
        throw new BackupRefused(
          'no_pg_tools',
          `\`${tool}\` is not on the PATH of this container.\n\n` +
            '  The PostgreSQL client programs ship with the server, so they are present on the default image\n' +
            '  (contextator/contextator) and absent from the -slim one, which carries no PostgreSQL at all.\n' +
            '  On -slim, take the backup where the database is — the server you named in DATABASE_URL, with\n' +
            '  its own pg_dump — or run this command from the default image pointed at the same URL.\n\n' +
            `  (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    },
  };
}

function runLocal(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`\`${command} ${args.join(' ')}\` exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * Reads `manifest.json` out of a `.tar.gz` **without unpacking the rest of it**.
 *
 * The manifest is written first precisely so that this is cheap, and the read **stops at the entry
 * after it**: a backup of a real instance is gigabytes, and every refusal this file makes is decided
 * from these few hundred bytes.
 *
 * The pipeline is built by hand rather than taken from `tar.list`, and the reason is worth recording.
 * `tar.list` offers an entry callback but no way to say *stop*, and the obvious workaround — throwing
 * out of the callback — does not abort the read: the throw happens inside an `EventEmitter` and leaves
 * the process with an **uncaught exception** rather than a rejected promise. Measured, with a probe
 * that built a two-entry archive and waited: the read never settled and the process died at the
 * `throw`. So the source, the gunzip and the parser are held here, and the first thing that settles
 * destroys all three.
 */
export async function readArchiveManifest(archivePath: string): Promise<Manifest> {
  const body = await new Promise<Buffer | null>((resolve, reject) => {
    const source = createReadStream(archivePath);
    const gunzip = createGunzip();
    const parser = new tar.Parser();
    let settled = false;

    const finish = (value: Buffer | null, err?: Error): void => {
      if (settled) return;
      settled = true;
      // Destroyed in the order the data flows, so nothing downstream is handed a chunk of a stream
      // that has already gone. Anything any of them emits afterwards is swallowed by `settled`.
      source.destroy();
      gunzip.destroy();
      parser.end();
      if (err) reject(err);
      else resolve(value);
    };

    parser.on('entry', (entry) => {
      if (settled) {
        entry.resume();
        return;
      }
      if (entry.path !== MANIFEST_ENTRY) {
        // Anything before the manifest means this file was not written by `backup`. Said from the
        // first entry rather than after streaming a whole archive to find out it never arrives.
        finish(
          null,
          new BackupRefused(
            'not_a_backup',
            `The first entry in this archive is "${entry.path}", not "${MANIFEST_ENTRY}". ` +
              'A Contextator instance backup always writes its manifest first, so this file was written by something else.',
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      entry.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_MANIFEST_BYTES) {
          finish(null, new BackupRefused('unreadable_manifest', 'The manifest in this archive is implausibly large.'));
          return;
        }
        chunks.push(chunk);
      });
      entry.on('end', () => finish(Buffer.concat(chunks)));
    });

    // A plain `.tar`, a text file with the right name, a truncated download: all of them arrive here
    // as a zlib error, and a zlib error is not a sentence anybody can act on.
    gunzip.on('error', () =>
      finish(null, new BackupRefused('not_a_backup', `"${archivePath}" is not a gzipped tar archive, so it is not one this command wrote.`)),
    );
    source.on('error', (err) => finish(null, err));
    parser.on('error', (err) => finish(null, err as Error));
    parser.on('end', () => finish(null));

    source.pipe(gunzip).pipe(parser);
  });

  if (!body) throw new BackupRefused('not_a_backup', `This archive holds no "${MANIFEST_ENTRY}", so it is not a Contextator instance backup.`);
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    throw new BackupRefused('unreadable_manifest', `"${MANIFEST_ENTRY}" in this archive is not JSON.`);
  }
  return parseManifest(raw);
}

/**
 * The major version out of anything PostgreSQL calls a version: `16.4 (Debian 16.4-1)`,
 * `PostgreSQL 17.2`, `pg_restore (PostgreSQL) 17.2`. `null` when there is no number to find, which is
 * treated as "say nothing" rather than as a refusal — a version string nobody recognised is not
 * evidence of anything.
 */
export function majorVersion(version: string): number | null {
  const match = /(\d+)(?:\.\d+)*/.exec(version.replace(/^[^\d]*\(PostgreSQL\)\s*/i, ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

export type ServerVersionVerdict = { ok: true; note: string | null } | { ok: false; code: 'server_too_old'; message: string };

/**
 * Whether this server can take this dump — which is a question about major versions and only one
 * direction of it is a refusal.
 *
 * **Forward is the supported direction and it is the whole of the major upgrade procedure**
 * ([OPERATIONS.md](../.ssot/OPERATIONS.md) §3.2): a dump taken from 16 restores into 17, which is how
 * a cluster crosses a major version when the two servers never run side by side — and they never do
 * here, because [ADR-0006](../.ssot/ADR.md#adr-0006) puts exactly one PostgreSQL inside the image and
 * `pg_upgrade` needs both majors' binaries at once.
 *
 * **Backward is refused rather than attempted.** `pg_dump` writes SQL for the server it read, and a
 * newer server's syntax is not a subset of an older one's; what that produces is not a clean failure
 * but a `pg_restore` that applies part of the archive and stops — which, under `--clean --if-exists`,
 * is an instance whose old data has already been dropped. The refusal costs nothing and the attempt
 * can cost everything.
 */
export function checkServerVersion(manifest: Manifest, serverVersion: string): ServerVersionVerdict {
  const from = majorVersion(manifest.database.serverVersion);
  const into = majorVersion(serverVersion);
  if (from === null || into === null) return { ok: true, note: null };
  if (into < from) {
    return {
      ok: false,
      code: 'server_too_old',
      message:
        `This backup was taken from PostgreSQL ${from} and this server is PostgreSQL ${into}. ` +
        'A dump does not restore into a server older than the one it came from: pg_restore would apply part of it and stop, ' +
        'and --clean has already dropped what was there by then. Restore it into PostgreSQL ' +
        `${from} or newer. Nothing has been written.`,
    };
  }
  if (into > from) {
    return {
      ok: true,
      note:
        `This backup came from PostgreSQL ${from} and this server is PostgreSQL ${into}. That is the major upgrade ` +
        'direction and it is the procedure: the restore rebuilds every index, including the HNSW one, on this server.',
    };
  }
  return { ok: true, note: null };
}

/** Total size and file count of a directory tree, for the manifest's own accounting. */
export async function measureTree(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files++;
        bytes += (await fs.stat(full)).size;
      }
    }
  };
  try {
    await walk(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { files, bytes };
}

/** The prose half of the manifest: what this file is, and the two things it deliberately is not. */
export function readmeFor(manifest: Manifest): string {
  const { counts, secretKey } = manifest;
  const lines = [
    `Contextator instance backup`,
    `Taken ${manifest.createdAt} by ${manifest.product.name} ${manifest.product.version}, manifest format ${manifest.manifestVersion}.`,
    `Database: ${manifest.database.mode}${manifest.database.target ? ` — ${manifest.database.target}` : ''}, ` +
      `server ${manifest.database.serverVersion}, dumped by ${manifest.database.dumpToolVersion}.`,
    `Schema version ${manifest.schema.version}, ${manifest.schema.migrations} migration(s) applied.`,
    '',
    'What is in it:',
    `  - ${DATABASE_ENTRY} — pg_dump -Fc of the whole database (${counts.databaseDumpBytes} bytes): ` +
      `${counts.projects} project(s), ${counts.documents} document(s), ${counts.chunks} chunk(s), and every account, ` +
      'session, MCP token, audit event and logged search along with them.',
    `  - ${DATA_PREFIX}/ — the materialised files of ${counts.uploadSources} upload source(s): ` +
      `${counts.uploadFiles} file(s), ${counts.uploadBytes} bytes. These are the only copy of their content anywhere; ` +
      'git checkouts and Notion pulls are not in here because they are re-clonable and re-pullable.',
    '',
    'What is NOT in it, and will not be:',
    secretKey.present
      ? `  - SECRET_KEY. The instance had one, and ${secretKey.encryptedSources} source(s) hold a credential encrypted under it. ` +
        `Only a key check value travels (${secretKey.fingerprint}), which is enough for a restore to refuse the wrong key and ` +
        'nothing like enough to be the key. Keep the key somewhere this file is not: a backup carrying it would be the whole ' +
        'instance in one place, which is exactly what encrypting the credentials was for.'
      : '  - SECRET_KEY. The instance had none set, so nothing in the dump is encrypted under one.',
    '  - The embedding model cache. It re-downloads.',
    "  - A local source's own directory. That is your documentation, backed up wherever it lives.",
    '',
    'Restore it with:  npm run restore -- <this file>',
    '',
    'A restore is destructive by design: it replaces the database with what is in here, and replaces each',
    'upload tree listed below with the copy in here. Read the manifest before running it on an instance',
    'that has anything you want to keep.',
    '',
  ];
  if (manifest.uploads.length > 0) {
    lines.push('Upload trees carried:');
    for (const upload of manifest.uploads) {
      lines.push(`  - ${upload.project} / ${upload.source} — ${upload.files} file(s), ${upload.bytes} bytes, restored to ${upload.path}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
