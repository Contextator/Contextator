import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The packaging half of [ADR-0069](../.ssot/ADR.md#adr-0069): one `DATABASE_URL` decides between the
 * embedded PostgreSQL and one an operator runs, and a second image target carries no PostgreSQL at
 * all. None of that is reachable from a unit test — it is a Dockerfile, a compose file and a shell
 * script — but every one of the properties below is a *line* whose deletion is silent and whose
 * failure is expensive, which is the same case `test/dockerhub-description.test.ts` exists for.
 *
 * What is asserted here is what CI's image job and `release.yml` cannot assert cheaply: the
 * *default* is still the single container. An image built with the wrong stage last, or a compose
 * file that went back to forcing `DATABASE_URL` empty, both pass every behavioural check there is
 * while quietly changing what a fresh `docker compose up -d` installs.
 */
const root = path.join(__dirname, '..');
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const composeSlim = read('docker-compose.slim.yml');
const composeBackup = read('docker-compose.backup.yml');
const entrypoint = read('docker', 'entrypoint.sh');
const envExample = read('.env.example');

describe('docker-compose.yml', () => {
  it('no longer forces DATABASE_URL empty, so .env can name an external database', () => {
    // The line this replaces was `DATABASE_URL: ""`, which made the variable the app already reads
    // unreachable from a container — the whole of the defect ADR-0069 is about.
    // Written as a pattern rather than a literal only because a literal `${…}` inside a JavaScript
    // string is a lint warning about a template that was meant to interpolate; this one is shell.
    expect(compose).toMatch(/DATABASE_URL: \$\{DATABASE_URL:-\}/);
    expect(compose).not.toMatch(/^\s*DATABASE_URL:\s*""\s*$/m);
  });

  it('still starts the embedded PostgreSQL when nothing names another one', () => {
    // `:-` and not `:?`: an unset variable is the default installation, not an error. The pgdata
    // volume stays mounted because Compose cannot make a mount conditional.
    expect(compose).toMatch(/\$\{CONTEXTATOR_PGDATA_PATH:-pgdata\}:\/var\/lib\/postgresql\/data/);
  });
});

describe('.env.example', () => {
  it('ships DATABASE_URL empty', () => {
    // It used to ship a live `postgres://…@localhost:5432/…` for `npm run dev`. Now that the
    // container reads the same line, a copied `.env.example` carrying that value would point a
    // fresh installation at a database that is not there — and the value that *is* there happens to
    // be the embedded one's, so it would have worked until somebody changed POSTGRES_PASSWORD.
    expect(envExample).toMatch(/^DATABASE_URL=$/m);
  });

  it('says what an external database has to be, where the operator sets it', () => {
    const block = envExample.slice(envExample.indexOf('# ---- Database ----'), envExample.indexOf('# ---- Persistent storage'));
    expect(block).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(block).toContain('PostgreSQL 16 or newer');
    // The consequence that is easiest to discover too late.
    expect(block).toMatch(/backups/i);
  });
});

describe('docker-compose.slim.yml', () => {
  it('pulls the -slim tag and refuses to start without a DATABASE_URL', () => {
    expect(composeSlim).toMatch(/image: contextator\/contextator:\$\{CONTEXTATOR_TAG:-latest\}-slim/);
    // `:?` — Compose fails with this message before a container is created. The entrypoint says it
    // again for anyone running the image without Compose; neither is the only line that does.
    expect(composeSlim).toMatch(/DATABASE_URL:\s*\$\{DATABASE_URL:\?/);
  });

  it('mounts no pgdata volume, because there is no cluster in that image', () => {
    expect(composeSlim).not.toContain('/var/lib/postgresql/data');
    expect(composeSlim).not.toContain('CONTEXTATOR_PGDATA');
  });
});

describe('docker-compose.backup.yml', () => {
  it('uses the full image tools but requires an external database and never mounts its cluster', () => {
    expect(composeBackup).toMatch(/image: contextator\/contextator:\$\{CONTEXTATOR_TAG:-latest\}\s*$/m);
    expect(composeBackup).toMatch(/DATABASE_URL:\s*\$\{DATABASE_URL:\?/);
    expect(composeBackup).not.toContain('/var/lib/postgresql/data');
    expect(composeBackup).not.toContain('pgdata');
  });

  it('shares the app user and waits for healthy startup before taking the first backup', () => {
    expect(composeBackup).toContain('user: "1000:1000"');
    expect(composeBackup).toContain('HOME: /tmp');
    expect(composeBackup).toMatch(/depends_on:\s+contextator:\s+condition: service_healthy/);
    expect(composeBackup).toContain('restart: "on-failure:3"');
    expect(composeBackup).toContain('BACKUP_STAGING_DIR: /data/.scheduled-backup-staging');
  });
});

describe('Dockerfile', () => {
  const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((m) => m[1]);

  it('builds `full` last, so `docker build .` still builds the default installation', () => {
    // A multi-stage build with no --target builds the *last* stage. Moving `slim` below `full`
    // would silently change what every existing build command produces (ADR-0006 stays the default).
    expect(stages).toEqual(['build', 'slim', 'full']);
  });

  const fullStageAt = dockerfile.indexOf('FROM pgvector/pgvector:pg16 AS full');

  it('gives the slim stage no PostgreSQL, and tells its entrypoint so', () => {
    const slim = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS slim'), dockerfile.indexOf('# ---- full runtime'));
    expect(slim).toContain('CONTEXTATOR_EMBEDDED_POSTGRES=0');
    // The base image is the plain Node one; the postgres base belongs to `full` alone.
    expect(slim).not.toContain('pgvector/pgvector');
    // gosu comes free with the postgres base image and has to be installed here, or the entrypoint
    // cannot drop privileges to `node` at all.
    expect(slim).toMatch(/apt-get install[^\n]*gosu/);
  });

  it('keeps the embedded PostgreSQL and its first-run SQL on the full stage', () => {
    const full = dockerfile.slice(fullStageAt);
    expect(full).toContain('FROM pgvector/pgvector:pg16');
    expect(full).toContain('/docker-entrypoint-initdb.d/01-init.sql');
    expect(full).not.toContain('CONTEXTATOR_EMBEDDED_POSTGRES');
  });
});

describe('docker/entrypoint.sh', () => {
  it('defaults to the embedded PostgreSQL, which is what the full image relies on', () => {
    // The full stage sets no CONTEXTATOR_EMBEDDED_POSTGRES at all, so this default is the only
    // thing keeping the default installation starting its own database.
    expect(entrypoint).toMatch(/: "\$\{CONTEXTATOR_EMBEDDED_POSTGRES:=1\}"/);
  });

  it('starts no PostgreSQL when DATABASE_URL names one', () => {
    expect(entrypoint).toMatch(/if \[ -n "\$\{DATABASE_URL:-\}" \]; then\n\s+EMBEDDED_PG=0/);
    expect(entrypoint).toContain('if [ "$EMBEDDED_PG" = \'1\' ]; then\n  docker-entrypoint.sh postgres');
  });

  it('exits naming DATABASE_URL when there is no database and none to embed', () => {
    // The worst outcome this image can produce is a container that starts, finds nothing, and sits
    // there. The message has to carry the variable, what the server behind it must be, and the
    // image that needs neither — this asserts all three are still in it.
    const refusal = entrypoint.slice(
      entrypoint.indexOf('no database configured'),
      entrypoint.indexOf('exit 1', entrypoint.indexOf('no database configured')),
    );
    expect(refusal).toContain('DATABASE_URL=postgres://');
    expect(refusal).toContain('pgvector');
    expect(refusal).toContain('contextator/contextator, embeds its own PostgreSQL');
  });

  it('tells the app its database disk only when that database is embedded', () => {
    // A forced re-index checks the disk it writes to — the database's — and only the embedded path
    // knows where that is. The external launch must not carry it: a stale PGDATA there would have the
    // check measure a disk the database does not live on.
    const launch = entrypoint.slice(entrypoint.indexOf('# ---- Contextator'));
    const [embedded, external] = launch.split('\nelse\n');
    expect(embedded).toMatch(/CONTEXTATOR_EMBEDDED_PGDATA="\$PGDATA"[^\n]*\\\n\s+gosu node node \/app\/dist\/server\.js/);
    expect(external.slice(0, external.indexOf('fi'))).not.toContain('CONTEXTATOR_EMBEDDED_PGDATA');
  });

  it('never prints the credential in the connection string it logs', () => {
    // The startup log names the database it chose, and a connection string carries a password.
    expect(entrypoint).toContain('redact_url');
    expect(entrypoint).toMatch(/log "database: external — \$\(redact_url "\$DATABASE_URL"\)"/);
  });

  it('warns when the URL is the container’s own loopback on an image that embeds a database', () => {
    // The upgrade trap: a `.env` copied from the old `.env.example` names localhost:5432, which used
    // to be cleared and now means "do not start the embedded PostgreSQL, connect to this container's
    // loopback" — where nothing is listening precisely because of that line. Warned rather than
    // refused: the same address is correct for a container sharing the host's network namespace.
    expect(entrypoint).toMatch(/warning: .*loopback/);
  });

  /**
   * **The loopback patterns are run, not read.** The first version of this guard asserted the pattern
   * text with `toContain`, and that is how the defect it exists for got in: `*@[::1]:*` *reads* as the
   * IPv6 loopback and is a bracket expression over `:` and `1`, so it matches nothing that address
   * ever appears in — a warning that never fires, which is worse than no warning because it reads as
   * covered. A literal assertion cannot tell those apart, and pinning one spelling leaves every other
   * variant free to break silently. So the `case` patterns are lifted out of the script and executed
   * by a shell against a table of addresses, which is the only thing that answers *does it match*.
   */
  describe('the loopback patterns, executed', () => {
    const block = entrypoint.slice(
      entrypoint.indexOf('case "$DATABASE_URL" in'),
      entrypoint.indexOf('esac', entrypoint.indexOf('case "$DATABASE_URL" in')),
    );
    // The alternation line: everything up to the `)` that opens the branch body.
    const patterns = block.split('\n').find((line) => line.trimStart().startsWith('*@'));

    const matches = (url: string): boolean => {
      expect(patterns, 'no `*@…` pattern line found in the DATABASE_URL case block').toBeTruthy();
      const script = `case "$1" in\n${patterns}\n  echo MATCH ;;\n*) echo NO ;;\nesac`;
      const run = spawnSync('bash', ['-c', script, 'contextator-test', url], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      return run.stdout.trim() === 'MATCH';
    };

    // Both spellings of both loopback addresses, and both with and without a port — a URL may carry
    // either, and the `/` forms are exactly the ones a single pinned literal would have let go.
    it.each([
      'postgres://contextator:contextator@localhost:5432/contextator', // the old .env.example line
      'postgres://u:p@localhost/contextator',
      'postgres://u:p@127.0.0.1:5432/contextator',
      'postgres://u:p@127.0.0.1/contextator',
      'postgres://u:p@[::1]:5432/contextator',
      'postgres://u:p@[::1]/contextator',
    ])('warns on %s', (url) => {
      expect(matches(url)).toBe(true);
    });

    it.each([
      'postgres://u:p@db.example.com:5432/contextator',
      'postgres://u:p@10.0.0.5:5432/contextator',
      'postgres://u:p@postgres.internal/contextator',
    ])('stays quiet on %s', (url) => {
      expect(matches(url)).toBe(false);
    });
  });
});

/**
 * The `contextator` command's packaging ([ADR-0131](../.ssot/ADR.md#adr-0131)): a third way to start the
 * image, decided by the first argument alone. Like the loopback patterns above, it is **run**: the real
 * entrypoint under bash, with `id`, `gosu`, `node`, `chown` and the upstream PostgreSQL entrypoint
 * replaced by stubs that write down how they were called. What a stub's log does not contain is as much
 * of the assertion as what it does: the command must start no database and fix no ownership.
 */
describe('docker/entrypoint.sh: the contextator command', () => {
  let work: string;
  let stubs: string;
  let log: string;

  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'ctx-entrypoint-'));
    stubs = path.join(work, 'bin');
    log = path.join(work, 'calls.log');
    mkdirSync(stubs);
    // Each stub records its own name and arguments, one call per line.
    for (const name of ['gosu', 'node', 'chown', 'docker-entrypoint.sh', 'pg_isready']) {
      // gosu execs its command, so its exit status is the command's.
      stub(name, `echo "${name} $*" >> "$STUB_LOG"; exit "\${STUB_EXIT_${name === 'node' || name === 'gosu' ? 'NODE' : 'OTHER'}:-0}"`);
    }
    stub('id', 'echo "$STUB_UID"');
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** The entrypoint as a slim image would run it: no database, none to embed, directories somewhere writable. */
  const start = (args: string[], env: Record<string, string> = {}) => {
    writeFileSync(log, '');
    const result = spawnSync('bash', [path.join(root, 'docker', 'entrypoint.sh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${stubs}:/usr/bin:/bin`,
        STUB_LOG: log,
        STUB_UID: '0',
        CONTEXTATOR_EMBEDDED_POSTGRES: '0',
        MODEL_CACHE_DIR: path.join(work, 'models'),
        DATA_DIR: path.join(work, 'data'),
        ...env,
      },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { ...result, calls };
  };

  it('runs the command as node through gosu when started as root, and starts nothing else', () => {
    const run = start(['contextator', 'project', 'create', 'docs', '--git', 'https://example.com/r', '--wait']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.calls).toEqual(['gosu node node /app/dist/cli.js project create docs --git https://example.com/r --wait']);
    // No ownership fix: the directories were not even created, let alone chowned.
    expect(existsSync(path.join(work, 'models'))).toBe(false);
    expect(existsSync(path.join(work, 'data'))).toBe(false);
  });

  it('works with no database configured at all, which is the slim image’s state in CI', () => {
    const run = start(['contextator', '--help']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('no database configured');
  });

  it('runs as whoever started it when that is not root, with no gosu and no root check', () => {
    const run = start(['contextator', 'backup', '/data/out.tar.gz'], { STUB_UID: '1000' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('must start as root');
    expect(run.calls).toEqual(['node /app/dist/cli.js backup /data/out.tar.gz']);
  });

  it('passes the command’s exit code through', () => {
    const run = start(['contextator', 'project', 'status', 'docs'], { STUB_EXIT_NODE: '6' });
    expect(run.status).toBe(6);
  });

  it('dispatches on a first argument that is exactly `contextator`, and on nothing else', () => {
    // These are the server starts of before: with no database to use, the slim refusal; never the command.
    for (const args of [[], ['server'], ['contextator-x'], ['--', 'contextator'], ['run', 'contextator'], ['CONTEXTATOR'], ['contextator ']]) {
      const run = start(args);
      expect(run.status, `args ${JSON.stringify(args)}`).toBe(1);
      expect(run.stderr, `args ${JSON.stringify(args)}`).toContain('no database configured');
      expect(run.calls.filter((call) => call.startsWith('node ') || call.includes('cli.js'))).toEqual([]);
    }
  });

  it('keeps the root requirement for the server start', () => {
    const run = start([], { STUB_UID: '1000' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('must start as root');
  });
});

describe('the contextator command in the image', () => {
  const pkg = JSON.parse(read('package.json')) as { bin?: Record<string, string> };

  it('is named by package.json `bin`, at the file the build writes from src/cli.ts (ADR-0131 decision 1)', () => {
    // tsc keeps src/'s layout under dist/ (rootDir is src), so the entry point is derived, not chosen.
    expect(pkg.bin).toEqual({ contextator: 'dist/cli.js' });
    expect(read('src', 'cli.ts').startsWith('#!/usr/bin/env node\n')).toBe(true);
    // The entry point starts the process and nothing else; the command's code is importable without running.
    expect(read('src', 'cli', 'main.ts')).not.toContain('process.argv');
  });

  it('is on PATH in both image targets, running the same file the entrypoint runs', () => {
    const slim = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS slim'), dockerfile.indexOf('# ---- full runtime'));
    const full = dockerfile.slice(dockerfile.indexOf('FROM pgvector/pgvector:pg16 AS full'));
    for (const stage of [slim, full]) {
      expect(stage).toContain('exec node /app/dist/cli.js "$@"');
      // `docker exec` and `--entrypoint contextator` skip the entrypoint, so the wrapper drops root itself.
      expect(stage).toContain('exec gosu node node /app/dist/cli.js "$@"');
      expect(stage).toContain('> /usr/local/bin/contextator;');
      expect(stage).toContain('chmod 0755 /usr/local/bin/contextator;');
    }
    expect(entrypoint).toContain('/app/dist/cli.js');
  });

  it('routes before anything that needs root, a database or PostgreSQL', () => {
    const dispatch = entrypoint.indexOf(`if [ "\${1:-}" = 'contextator' ]`);
    expect(dispatch).toBeGreaterThan(-1);
    for (const later of ["id -u)\" != '0'", 'chown -R node:node', 'DATABASE_URL:-', 'docker-entrypoint.sh postgres']) {
      expect(entrypoint.indexOf(later, dispatch + 1), later).toBeGreaterThan(dispatch);
    }
    // The only `id -u` before the dispatch's own is none: nothing above it decides anything.
    expect(entrypoint.slice(0, dispatch)).not.toContain('exit 1');
  });
});
