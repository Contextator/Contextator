import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
