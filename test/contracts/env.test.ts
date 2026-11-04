import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_KEEP, keepFromEnv, s3TargetFromEnv } from '../../scripts/backup-s3.js';
import { COMMAND_OPTIONS, type CliDeps, runCli } from '../../src/cli/main.js';
import {
  CHUNK_BUDGET_RESERVE_TOKENS,
  DENSE_CANDIDATES,
  deprecatedSettingWarnings,
  EnvSchema,
  loadConfig,
  SYNC_MIN_INTERVAL_MINUTES,
} from '../../src/config.js';
import { recordJson, withoutWording } from '../support/contract-json.js';

/**
 * **The environment as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 1): every key
 * `EnvSchema` reads, with its type, enum, bounds and default, and the few variables read outside it. An
 * added, removed or renamed key, a changed default or a tightened bound changes `__snapshots__/env.json`.
 *
 * - `server` — one entry per `EnvSchema` key except the internal ones (below): `input` is `z.toJSONSchema(…, { io: 'input',
 *   unrepresentable: 'any' })` for that key (type, enum, bounds, the default as written); `parsed` is what
 *   `EnvSchema.parse({ DATABASE_URL })` makes of it, which is what the server runs with when nothing is
 *   set; a key left unset has no `parsed`. `deprecated: true` marks a key `deprecatedSettingWarnings`
 *   names. `title` and `description` are dropped (Tier 3).
 * - `internal` — the keys `EnvSchema` reads that are not for operators (Tier 3, [ADR-0140](../../.ssot/ADR.md#adr-0140)
 *   decision 3): the entrypoint of the image hands them to the application. Same `input` as in `server`, plus who sets
 *   them. They are in no public document, and a change here is not a change to the contract.
 * - `removed` — the keys `EnvSchema` still names only to refuse a non-empty value (Tier 1 once, now gone;
 *   [ADR-0140](../../.ssot/ADR.md#adr-0140) decision 5): the release that removed each and what replaces it. They
 *   are not in `server`, so a settings list read from there never offers one.
 * - `cli` — `CONTEXTATOR_URL` and `CONTEXTATOR_TOKEN`, read by `src/cli/main.ts` and not by `EnvSchema`,
 *   probed by running the command without them.
 * - `flags` — the keys `EnvSchema` turns into a boolean with its `flag` transform, which `z.toJSONSchema`
 *   cannot see (it reports a string): what each spelling (`1`, `true`, `TRUE`, `yes`, …) parses to, keys with
 *   the same answers grouped. Only keys with a default are found; an optional flag with none is not.
 * - `database` — the libpq variables `loadConfig` accepts in place of `DATABASE_URL` (`PGHOST`,
 *   `PGDATABASE`), probed by loading a configuration with each.
 * - `backup` — `BACKUP_KEEP` (probed through `keepFromEnv`), the `BACKUP_S3_*` variables (probed through
 *   `s3TargetFromEnv`: the names it reads, which are required, the defaults, what it refuses) and
 *   `BACKUP_STAGING_DIR` (read in `scripts/backup.ts`; Tier 1 and `supported: true`, [ADR-0140](../../.ssot/ADR.md#adr-0140)
 *   decision 3: the README tells operators to set it and the chart sets it).
 * - `crossKeyRules` — the `superRefine` rules of `src/config.ts`: for each, an environment it refuses (with the keys
 *   the refusal is raised on) and the nearest one it accepts, probed by parsing them. The wording of a refusal is
 *   Tier 3 and is not recorded; that it is refused, and where, is.
 *
 * - `trustProxy` — `TRUST_PROXY`, which parses to a boolean by default but takes addresses, CIDR blocks and
 *   subnet names: what each spelling in a table of the likely ones parses to (or `refused`).
 *
 * **Not covered: what the other non-switch transforms accept** (the comma-separated list keys such as
 * `ALLOWED_ORIGINS` or `SOURCE_ALLOWED_HOSTS`, `ALLOWED_DOC_ROOTS`, `MCP_RATE_LIMIT_TOOLS`): the snapshot has
 * their default and the type they are written as, not which spellings they accept.
 *
 * **Not covered: a cross-key rule that is not in the table.** `z.toJSONSchema` does not see the `superRefine`; the
 * `crossKeyRules` table is the only record, and a rule added to `src/config.ts` is added to it by hand. The guard
 * below counts the rules it knows so that a forgotten one at least has to be argued with.
 *
 * Out of the contract: `EVAL_*` and the smoke variables (Tier 3), and `.env.example`, which a later phase
 * checks against this.
 *
 * **Normalisation.** A parsed value that holds the working directory (`DATA_DIR` is `path.resolve`d) has it
 * replaced by `<cwd>`, so the snapshot is the same on every checkout. Keys are sorted. Nothing else is
 * touched.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOT = path.join(import.meta.dirname, '__snapshots__', 'env.json');
const ROOT = path.join(import.meta.dirname, '..', '..');

/** Replaces the working directory wherever a parsed value holds it. */
function portable(value: unknown): unknown {
  const cwd = process.cwd();
  if (typeof value === 'string') return value.split(cwd).join('<cwd>');
  if (Array.isArray(value)) return value.map(portable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, portable(inner)]));
  }
  return value;
}

/** The names `deprecatedSettingWarnings` raises a warning for, from a configuration that sets all of them. */
function deprecatedKeys(): string[] {
  const warnings = deprecatedSettingWarnings({
    EMBEDDING_PROVIDER: 'openai',
    EMBEDDING_BASE_URL: undefined,
    OPENAI_BASE_URL: 'http://llm.example/v1',
  });
  return warnings.map((warning) => warning.split(' ')[0] as string);
}

/** Keys that are not for operators ([ADR-0140](../../.ssot/ADR.md#adr-0140) decision 3), and who sets them. */
const INTERNAL_KEYS: Record<string, { setBy: string }> = {
  CONTEXTATOR_EMBEDDED_PGDATA: { setBy: 'docker/entrypoint.sh' },
};

/**
 * Keys `EnvSchema` still names only to refuse them. They are not settings, so `server` does not list them; the
 * `removed` block does, with the release that removed each and what replaces it. `crossKeyRules` proves the refusal.
 */
const REMOVED_KEYS: Record<string, { removedIn: string; replacedBy: string }> = {
  CONFLUENCE_ALLOWED_HOSTS: { removedIn: '1.0.0', replacedBy: 'SOURCE_ALLOWED_HOSTS' },
};

function schemaInputs(): Record<string, unknown> {
  return (z.toJSONSchema(EnvSchema, { io: 'input', unrepresentable: 'any' }) as { properties: Record<string, unknown> }).properties;
}

/** The internal keys, each with the schema's own entry for it and the file that sets it (found there, not asserted from memory). */
function internalBlock(): Record<string, unknown> {
  const inputs = schemaInputs();
  const block: Record<string, unknown> = {};
  for (const [key, { setBy }] of Object.entries(INTERNAL_KEYS)) {
    expect(inputs).toHaveProperty(key);
    expect(readFileSync(path.join(ROOT, setBy), 'utf8')).toContain(`${key}=`);
    block[key] = { input: withoutWording(inputs[key]), setBy, tier: 3 };
  }
  return block;
}

function removedBlock(): Record<string, unknown> {
  const inputs = schemaInputs();
  const block: Record<string, unknown> = {};
  for (const [key, info] of Object.entries(REMOVED_KEYS)) {
    // Still in the schema (it is how the refusal happens), and refused when set: the entry is held to both.
    expect(inputs).toHaveProperty(key);
    expect(refusedAt({ [key]: 'x' }), `${key} is refused`).toEqual([key]);
    block[key] = { ...info, valueRefused: 'any non-empty value' };
  }
  return block;
}

function serverBlock(): Record<string, unknown> {
  const inputs = schemaInputs();
  const parsed = EnvSchema.parse({ DATABASE_URL: 'postgres://contract/contract' }) as Record<string, unknown>;
  const deprecated = new Set(deprecatedKeys());
  const block: Record<string, unknown> = {};
  for (const [key, input] of Object.entries(inputs)) {
    if (key in INTERNAL_KEYS || key in REMOVED_KEYS) continue;
    block[key] = {
      input: withoutWording(input),
      ...(parsed[key] === undefined ? {} : { parsed: portable(parsed[key]) }),
      ...(deprecated.has(key) ? { deprecated: true } : {}),
    };
  }
  return block;
}

/** Runs one command with the given environment and returns what it said and its exit code. */
async function runWith(env: Record<string, string | undefined>): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const deps: CliDeps = {
    env,
    io: { stdout: () => {}, stderr: (text) => (stderr += text) },
    fetch: async () => {
      throw new Error('the command must stop before it reaches the network');
    },
    sleep: async () => {},
    now: () => 0,
    readFile: () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
    readStdin: async () => '',
    runBackup: async () => 0,
    version: '0.0.0-contract',
  };
  return { ...(await runCli(['project', 'status', 'any'], deps).then((code) => ({ code }))), stderr };
}

async function cliBlock(): Promise<Record<string, unknown>> {
  const noUrl = await runWith({});
  const noToken = await runWith({ CONTEXTATOR_URL: 'http://127.0.0.1:1' });
  // A variable is only in the contract while the command still asks for it and still names it.
  expect(noUrl.code).toBe(2);
  expect(noUrl.stderr).toContain('CONTEXTATOR_URL');
  expect(noToken.code).toBe(2);
  expect(noToken.stderr).toContain('CONTEXTATOR_TOKEN');
  const flags = Object.keys(COMMAND_OPTIONS['project status']);
  expect(flags).toContain('url');
  expect(flags).toContain('token-file');
  return {
    CONTEXTATOR_URL: { appliesTo: 'every command except backup', instead: '--url', required: true },
    CONTEXTATOR_TOKEN: { appliesTo: 'every command except backup', instead: '--token-file', required: true },
  };
}

/** The spellings an operator might write for a switch, and what `flag` makes of each. */
const FLAG_SPELLINGS = ['1', 'true', 'TRUE', 'True', '0', 'false', 'yes', 'on', ''];

/** The keys the `flag` transform turns into booleans, grouped by what each spelling parses to. */
function flagsBlock(): Record<string, unknown> {
  const parsed = EnvSchema.parse({ DATABASE_URL: 'postgres://contract/contract' }) as Record<string, unknown>;
  // `TRUST_PROXY` also parses to a boolean by default but is not a switch: it has its own table below.
  const keys = Object.keys(parsed).filter((key) => typeof parsed[key] === 'boolean' && key !== 'TRUST_PROXY');
  const groups = new Map<string, { keys: string[]; parses: Record<string, unknown> }>();
  for (const key of keys) {
    const parses: Record<string, unknown> = {};
    for (const spelling of FLAG_SPELLINGS) {
      const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://contract/contract', [key]: spelling });
      parses[spelling === '' ? '(empty)' : spelling] = result.success ? (result.data as Record<string, unknown>)[key] : 'refused';
    }
    const id = JSON.stringify(parses);
    const group = groups.get(id) ?? { keys: [], parses };
    group.keys.push(key);
    groups.set(id, group);
  }
  // A group is named by its first key (sorted), so a new key that behaves differently adds a group rather than renumbering them all.
  return Object.fromEntries(
    [...groups.values()].map((group) => {
      const sortedKeys = group.keys.sort();
      return [`like ${sortedKeys[0]}`, { keys: sortedKeys, parses: group.parses }];
    }),
  );
}

/** What an operator might write for `TRUST_PROXY`: each way out the refusal names, and the spellings it rules out. */
const TRUST_PROXY_SPELLINGS = [
  '0',
  'false',
  'loopback',
  'linklocal',
  'uniquelocal',
  '192.0.2.7',
  '10.0.0.0/8',
  'fd00::/8',
  '172.18.0.0/16,loopback',
  'loopback, linklocal',
  '10.0.0.0/0',
  '10.0.0.0/33',
  '10.0.0.0/255.0.0.0',
  'localhost',
  '2',
  '1',
  'true',
  'TRUE',
  'yes',
];

/** What `TRUST_PROXY` accepts: not a switch, so its own table (the value Fastify is given for each spelling, or `refused`). */
function trustProxyBlock(): Record<string, unknown> {
  const parses: Record<string, unknown> = {};
  for (const spelling of TRUST_PROXY_SPELLINGS) {
    const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://contract/contract', TRUST_PROXY: spelling });
    parses[spelling] = result.success ? (result.data as Record<string, unknown>).TRUST_PROXY : 'refused';
  }
  expect(parses['10.0.0.0/8']).not.toBe('refused');
  expect(parses['1']).toBe('refused');
  return { default: '0', parses };
}

/** What `loadConfig` accepts instead of `DATABASE_URL`. `process.exit` is how it refuses, so it is caught here. */
function databaseBlock(): Record<string, unknown> {
  const loads = (env: Record<string, string>): boolean => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      loadConfig(env);
      return true;
    } catch {
      return false;
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  };
  expect(loads({})).toBe(false);
  expect(loads({ DATABASE_URL: 'postgres://contract/contract' })).toBe(true);
  expect(loads({ PGHOST: 'db.example' })).toBe(true);
  expect(loads({ PGDATABASE: 'contextator' })).toBe(true);
  expect(loads({ PGUSER: 'contextator' })).toBe(false);
  // The rest of the libpq set is node-postgres's own (`src/db/client.ts`); only that it is said there is checked.
  expect(readFileSync(path.join(ROOT, 'src', 'db', 'client.ts'), 'utf8')).toContain('PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE');
  return {
    instead: 'DATABASE_URL',
    libpq: { acceptedAlone: ['PGDATABASE', 'PGHOST'], readByNodePostgres: ['PGDATABASE', 'PGHOST', 'PGPASSWORD', 'PGPORT', 'PGUSER'] },
  };
}

/** `s3TargetFromEnv`, probed: the names it reads, the ones it insists on, its defaults, and what it refuses. */
function s3Block(): Record<string, unknown> {
  const valid: Record<string, string> = {
    BACKUP_S3_BUCKET: 'contract-bucket',
    BACKUP_S3_ACCESS_KEY_ID: 'key',
    BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
    BACKUP_S3_REGION: 'eu-central-1',
    BACKUP_S3_ENDPOINT: 'https://minio.example:9000/base/',
    BACKUP_S3_PREFIX: '/nightly/',
    BACKUP_S3_SESSION_TOKEN: 'token',
  };
  // Every name the function reads, found by watching it read: a variable added to it is added here.
  const reads = new Set<string>();
  const watched = new Proxy(valid, {
    get: (target, name) => {
      if (typeof name === 'string') reads.add(name);
      return target[name as string];
    },
  });
  s3TargetFromEnv(watched as NodeJS.ProcessEnv);

  let missing: string[] = [];
  try {
    s3TargetFromEnv({});
  } catch (err) {
    missing = (err as Error).message.match(/BACKUP_S3_[A-Z_]+/g) ?? [];
  }
  const minimal = { BACKUP_S3_BUCKET: 'contract-bucket', BACKUP_S3_ACCESS_KEY_ID: 'key', BACKUP_S3_SECRET_ACCESS_KEY: 'secret' };
  const defaults = s3TargetFromEnv(minimal);
  const refused = {
    BACKUP_S3_BUCKET: 'Bad_Bucket',
    BACKUP_S3_ENDPOINT: 'ftp://minio.example',
    BACKUP_S3_ENDPOINT_WITH_CREDENTIALS: 'https://user:pass@minio.example',
    BACKUP_S3_PREFIX: 'a/../b',
    BACKUP_S3_REGION: 'EU Central',
  };
  const refusals = Object.fromEntries(
    Object.entries(refused).map(([name, value]) => {
      const variable = name.replace('_WITH_CREDENTIALS', '');
      let refusedWith = 'accepted';
      try {
        s3TargetFromEnv({ ...minimal, [variable]: value });
      } catch (err) {
        refusedWith = (err as Error).message.match(/BACKUP_S3_[A-Z_]+/)?.[0] ?? 'refused';
      }
      return [name, refusedWith];
    }),
  );
  expect(Object.values(refusals).every((verdict) => verdict !== 'accepted')).toBe(true);
  return {
    defaults: { endpoint: defaults.endpoint, prefix: defaults.prefix, region: defaults.region, sessionToken: defaults.sessionToken ?? null },
    read: [...reads].sort(),
    refusedByVariable: refusals,
    required: [...missing].sort(),
    trimsAndNormalises: { endpoint: 'no trailing slash', prefix: 'no leading or trailing slash' },
    withEveryVariable: (() => {
      const target = s3TargetFromEnv(valid);
      return { endpoint: target.endpoint, prefix: target.prefix, sessionTokenKept: target.sessionToken !== undefined };
    })(),
  };
}

function backupBlock(): Record<string, unknown> {
  const accepts = ['1', '7', '999999'];
  const rejects = ['0', '-1', '1.5', '1000000', 'seven'];
  for (const value of accepts) expect(keepFromEnv({ BACKUP_KEEP: value })).toBe(Number(value));
  for (const value of rejects) expect(() => keepFromEnv({ BACKUP_KEEP: value })).toThrow(/BACKUP_KEEP/);
  // `BACKUP_STAGING_DIR` is read by the command's own body, not by a function that can be probed. It is Tier 1
  // (ADR-0140 decision 3): the README names it for the scheduled-backup sidecar, so the recorded `supported: true`
  // is held to the document that makes it true.
  expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toContain('BACKUP_STAGING_DIR');
  expect(readFileSync(path.join(ROOT, 'scripts', 'backup.ts'), 'utf8')).toContain('env.BACKUP_STAGING_DIR || config.DATA_DIR');
  return {
    BACKUP_KEEP: { accepts, default: keepFromEnv({}), rejects },
    BACKUP_STAGING_DIR: { default: 'DATA_DIR', readBy: 'scripts/backup.ts', supported: true },
    s3: s3Block(),
  };
}

/** One `superRefine` rule: an environment it refuses and the nearest one it accepts, each on top of `DATABASE_URL` alone. */
interface RuleProbe {
  refuses: Record<string, string>;
  accepts: Record<string, string>;
}

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const LOCAL_LLM = 'http://localhost:11434/v1';

/**
 * The cross-key rules of the `superRefine` in `src/config.ts`, one entry per rule, with the boundary written from the
 * constants the rule itself reads, so that a moved boundary changes the snapshot rather than passing silently
 * (the `BACKUP_KEEP` pattern: probe, record). A rule with several issues has one entry per issue.
 */
const CROSS_KEY_RULES: Record<string, RuleProbe> = {
  'OPENAI_BASE_URL is validated only when it is read': {
    refuses: { EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'localhost:11434' },
    accepts: { EMBEDDING_PROVIDER: 'local', OPENAI_BASE_URL: 'localhost:11434' },
  },
  'OPENAI_API_KEY is required for the openai provider talking to OpenAI': {
    refuses: { EMBEDDING_PROVIDER: 'openai' },
    accepts: { EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: LOCAL_LLM },
  },
  'OPENAI_API_KEY is required when EMBEDDING_BASE_URL names api.openai.com': {
    refuses: { EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'https://api.openai.com/v1' },
    accepts: { EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'k' },
  },
  'CHUNK_OVERLAP_TOKENS is smaller than CHUNK_MAX_TOKENS': {
    refuses: { CHUNK_MAX_TOKENS: '96', CHUNK_OVERLAP_TOKENS: '96' },
    accepts: { CHUNK_MAX_TOKENS: '96', CHUNK_OVERLAP_TOKENS: '95' },
  },
  'CHUNK_MAX_TOKENS plus the reserve fits in a stated EMBEDDING_MAX_INPUT_TOKENS': {
    refuses: { CHUNK_MAX_TOKENS: '96', EMBEDDING_MAX_INPUT_TOKENS: String(96 + CHUNK_BUDGET_RESERVE_TOKENS - 1) },
    accepts: { CHUNK_MAX_TOKENS: '96', EMBEDDING_MAX_INPUT_TOKENS: String(96 + CHUNK_BUDGET_RESERVE_TOKENS) },
  },
  'HNSW_EF_SEARCH reaches the dense candidates of one search': {
    refuses: { HNSW_EF_SEARCH: String(DENSE_CANDIDATES - 1) },
    accepts: { HNSW_EF_SEARCH: String(DENSE_CANDIDATES) },
  },
  'SYNC_DEFAULT_INTERVAL_MINUTES is 0 or at least the API floor': {
    refuses: { SYNC_DEFAULT_INTERVAL_MINUTES: String(SYNC_MIN_INTERVAL_MINUTES - 1) },
    accepts: { SYNC_DEFAULT_INTERVAL_MINUTES: String(SYNC_MIN_INTERVAL_MINUTES) },
  },
  'SYNC_DEFAULT_INTERVAL_MINUTES: 1 is below the floor, 0 is allowed': {
    refuses: { SYNC_DEFAULT_INTERVAL_MINUTES: '1' },
    accepts: { SYNC_DEFAULT_INTERVAL_MINUTES: '0' },
  },
  'ALLOWED_DOC_ROOTS names a directory': {
    refuses: { ALLOWED_DOC_ROOTS: ',' },
    accepts: { ALLOWED_DOC_ROOTS: '/docs' },
  },
  'AUTH_SESSION_TTL_DAYS is not shorter than AUTH_SESSION_IDLE_MS': {
    refuses: { AUTH_SESSION_TTL_DAYS: '1', AUTH_SESSION_IDLE_MS: String(24 * 60 * 60_000 + 1) },
    accepts: { AUTH_SESSION_TTL_DAYS: '1', AUTH_SESSION_IDLE_MS: String(24 * 60 * 60_000) },
  },
  'SECRET_KEY_PREVIOUS needs SECRET_KEY': {
    refuses: { SECRET_KEY_PREVIOUS: KEY_A },
    accepts: { SECRET_KEY: KEY_B, SECRET_KEY_PREVIOUS: KEY_A },
  },
  'SECRET_KEY_PREVIOUS differs from SECRET_KEY': {
    refuses: { SECRET_KEY: KEY_A, SECRET_KEY_PREVIOUS: KEY_A },
    accepts: { SECRET_KEY: KEY_A, SECRET_KEY_PREVIOUS: KEY_B },
  },
  'OIDC_ISSUER_URL needs OIDC_CLIENT_ID and OIDC_CLIENT_SECRET': {
    refuses: { OIDC_ISSUER_URL: 'https://idp.example' },
    accepts: { OIDC_ISSUER_URL: 'https://idp.example', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret' },
  },
  'OIDC_GROUPS_CLAIM needs OIDC_ISSUER_URL': {
    refuses: { OIDC_GROUPS_CLAIM: 'groups' },
    accepts: { OIDC_GROUPS_CLAIM: 'groups', OIDC_ISSUER_URL: 'https://idp.example', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret' },
  },
  'NOTION_OAUTH_CLIENT_ID needs NOTION_OAUTH_CLIENT_SECRET': {
    refuses: { NOTION_OAUTH_CLIENT_ID: 'id' },
    accepts: { NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://docs.example', SECRET_KEY: KEY_A },
  },
  'NOTION_OAUTH_CLIENT_SECRET needs NOTION_OAUTH_CLIENT_ID': {
    refuses: { NOTION_OAUTH_CLIENT_SECRET: 'secret' },
    accepts: { NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://docs.example', SECRET_KEY: KEY_A },
  },
  'Notion OAuth needs a redirect URI or PUBLIC_BASE_URL, and SECRET_KEY': {
    refuses: { NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 'secret' },
    accepts: {
      NOTION_OAUTH_CLIENT_ID: 'id',
      NOTION_OAUTH_CLIENT_SECRET: 'secret',
      NOTION_OAUTH_REDIRECT_URI: 'https://docs.example/cb',
      SECRET_KEY: KEY_A,
    },
  },
  // Not a `superRefine` rule but a removed key (ADR-0140 decision 5): the table is where a refusal is recorded.
  'CONFLUENCE_ALLOWED_HOSTS was removed': {
    refuses: { CONFLUENCE_ALLOWED_HOSTS: 'wiki.example' },
    accepts: { CONFLUENCE_ALLOWED_HOSTS: '' },
  },
};

/** The keys a refusal is raised on, sorted, or `null` when the environment loads. */
function refusedAt(env: Record<string, string>): string[] | null {
  const result = EnvSchema.safeParse({ DATABASE_URL: 'postgres://contract/contract', ...env });
  if (result.success) return null;
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))].sort();
}

function crossKeyRulesBlock(): Record<string, unknown> {
  const block: Record<string, unknown> = {};
  for (const [rule, probe] of Object.entries(CROSS_KEY_RULES)) {
    const refused = refusedAt(probe.refuses);
    // The probe must be about its rule: refused, and the nearest environment it allows must load.
    expect(refused, `${rule}: refuses`).not.toBeNull();
    expect(refusedAt(probe.accepts), `${rule}: accepts`).toBeNull();
    block[rule] = { accepts: probe.accepts, refuses: probe.refuses, refusedAt: refused };
  }
  return block;
}

describe('the environment is a contract', () => {
  it('records every key EnvSchema reads, the CLI, database, flag and backup variables', async () => {
    const server = serverBlock();
    // Guard the walk itself: an empty or partial schema would record itself as the contract.
    expect(Object.keys(server).length).toBeGreaterThan(100);
    expect(server).toHaveProperty('DATABASE_URL');
    expect(server).toHaveProperty('SECRET_KEY');
    // Internal keys are recorded in their own block and not twice.
    expect(server).not.toHaveProperty('CONTEXTATOR_EMBEDDED_PGDATA');
    expect(server).not.toHaveProperty('CONFLUENCE_ALLOWED_HOSTS');
    expect(DEFAULT_KEEP).toBe(7);

    await expect(
      recordJson({
        backup: backupBlock(),
        cli: await cliBlock(),
        crossKeyRules: crossKeyRulesBlock(),
        database: databaseBlock(),
        flags: flagsBlock(),
        internal: internalBlock(),
        removed: removedBlock(),
        server,
        trustProxy: trustProxyBlock(),
      }),
    ).toMatchFileSnapshot(SNAPSHOT);
  });

  it('marks a deprecated key, and only a key the schema has', () => {
    const names = deprecatedKeys();
    expect(names).toEqual(['OPENAI_BASE_URL']);
    expect(deprecatedSettingWarnings({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: LOCAL_LLM, OPENAI_BASE_URL: LOCAL_LLM })).toEqual([]);
    const server = serverBlock();
    for (const name of names) expect(server[name]).toMatchObject({ deprecated: true });
  });

  /**
   * The number of `ctx.addIssue` calls in the `superRefine`. A rule added there changes it, and the failure is the
   * prompt to add the rule to `CROSS_KEY_RULES` (and to raise this number); the table is by hand, the guard is not.
   */
  it('has been told how many rules the superRefine holds', () => {
    const source = readFileSync(path.join(ROOT, 'src', 'config.ts'), 'utf8');
    const refine = source.slice(source.indexOf('.superRefine('), source.indexOf('export type Config'));
    expect((refine.match(/ctx\.addIssue\(/g) ?? []).length).toBe(17);
    // Every rule has both halves of its probe: an entry that only refuses would pin nothing about the boundary.
    for (const probe of Object.values(CROSS_KEY_RULES)) expect(Object.keys(probe.accepts).length).toBeGreaterThan(0);
  });
});
