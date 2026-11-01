import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../../src/cli/api-client.js';
import { COMMAND_OPTIONS, type CliDeps, runCli } from '../../src/cli/main.js';
import { recordJson } from '../support/contract-json.js';

/**
 * **The `contextator` command as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 1, with
 * [ADR-0131](../../.ssot/ADR.md#adr-0131)): the commands, each command's flags, the exit codes, and the
 * keys of the object `--json` prints. A command, flag or exit code added, removed or renamed, or a key of
 * the `--json` object, changes `__snapshots__/cli.json`.
 *
 * - `commands` — the API commands by the words that name them, each with its flags as `parseArgs` is given
 *   them (`COMMAND_OPTIONS`, `src/cli/main.ts`): `type`, and `multiple` / `short` where set. `backup` takes
 *   the arguments of `scripts/backup.ts` and nothing here.
 * - `exit` — `EXIT`, `src/cli/api-client.ts`.
 * - `json` — per command, the dotted paths of the keys `--json` prints, taken from one real run of the
 *   command against a canned admin API (the `fetch` handed to `runCli`, no network). The scenarios cover the
 *   optional keys too (`run`, `index.error`), and the union is recorded. Where the command prints an
 *   object the server made and passes through (`mcpToken.token`, `token`) the path stops there: its shape
 *   is the admin API's contract, not this command's.
 *
 * **Out of the contract:** the usage and help text (Tier 3; the "Commands:" list in it is only checked
 * against `COMMAND_OPTIONS` below, so a command cannot be added without a flag record) and the values
 * `--json` prints.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOT = path.join(import.meta.dirname, '__snapshots__', 'cli.json');

const PROJECT_ID = '3f0a1c52-8d1e-4b7a-9c60-5a2f6d9e1b11';
const BASE = 'http://127.0.0.1:3444';
const TOKEN = 'ctxk_contract-credential';

interface Canned {
  status?: number;
  body: unknown;
}

/** The routes the commands use, answered from a table. `phase` and `runStatus` choose the index run's outcome. */
function adminApi(scenario: { phase: 'done' | 'error'; runStatus: 'done' | 'error' }): typeof fetch {
  const project = { id: PROJECT_ID, name: 'docs', mcpUrl: `${BASE}/mcp/docs`, status: 'idle' };
  const routes: Record<string, Canned> = {
    'GET /api/health': { body: { ok: true, version: '0.0.0-contract' } },
    'GET /api/projects': { body: [project] },
    'POST /api/projects': { status: 201, body: { ...project, mcpToken: { token: { id: 'tok-1' }, secret: 'ctxm_first' } } },
    [`POST /api/projects/${PROJECT_ID}/sources`]: { status: 201, body: { id: 'src-1', name: 'git', type: 'git', label: null, hasSecret: false } },
    [`GET /api/projects/${PROJECT_ID}/sources`]: { body: [{ id: 'src-1', name: 'git' }] },
    [`POST /api/projects/${PROJECT_ID}/mcp-tokens`]: { status: 201, body: { token: { id: 'tok-2', name: 'ci' }, secret: 'ctxm_second' } },
    [`GET /api/projects/${PROJECT_ID}/runs`]: {
      body: { runs: [{ id: 'run-1', status: scenario.runStatus, error: scenario.runStatus === 'error' ? 'boom' : null }] },
    },
    [`GET /api/projects/${PROJECT_ID}/status`]: {
      body: { project, job: { phase: scenario.phase, filesTotal: 2, filesDone: 2, ...(scenario.phase === 'error' ? { error: 'boom' } : {}) } },
    },
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const canned = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!canned) return new Response(JSON.stringify({ error: 'not_found', message: 'No such route' }), { status: 404 });
    return new Response(JSON.stringify(canned.body), { status: canned.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function run(
  argv: string[],
  fetchImpl: typeof fetch = adminApi({ phase: 'done', runStatus: 'done' }),
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  let clock = 0;
  const deps: CliDeps = {
    env: { CONTEXTATOR_URL: BASE, CONTEXTATOR_TOKEN: TOKEN },
    io: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    fetch: fetchImpl,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    readFile: () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
    readStdin: async () => '',
    runBackup: async () => 0,
    version: '0.0.0-contract',
  };
  const code = await runCli(argv, deps);
  return { code, stdout, stderr };
}

/** The dotted paths of an object's keys. A path in `opaque` is a leaf: what is under it is not this command's. */
function keyPaths(value: unknown, opaque: ReadonlySet<string>, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const at = prefix === '' ? key : `${prefix}.${key}`;
    paths.push(at);
    if (!opaque.has(at)) paths.push(...keyPaths(inner, opaque, at));
  }
  return paths;
}

interface JsonCase {
  command: string;
  scenarios: Array<{ argv: string[]; api: Parameters<typeof adminApi>[0]; code: number }>;
  opaque: string[];
}

const create = ['project', 'create', 'docs', '--git', 'https://github.com/acme/handbook', '--json'];
const cases: JsonCase[] = [
  {
    command: 'project create',
    scenarios: [
      { argv: [...create, '--wait'], api: { phase: 'done', runStatus: 'done' }, code: EXIT.ok },
      { argv: [...create, '--wait'], api: { phase: 'error', runStatus: 'error' }, code: EXIT.runFailed },
    ],
    opaque: ['mcpToken.token'],
  },
  {
    command: 'project status',
    scenarios: [
      { argv: ['project', 'status', 'docs', '--json'], api: { phase: 'done', runStatus: 'done' }, code: EXIT.ok },
      { argv: ['project', 'status', 'docs', '--json'], api: { phase: 'error', runStatus: 'error' }, code: EXIT.ok },
    ],
    opaque: [],
  },
  {
    command: 'source add',
    scenarios: [
      { argv: ['source', 'add', '--project', 'docs', '--type', 'git', '--json'], api: { phase: 'done', runStatus: 'done' }, code: EXIT.ok },
    ],
    opaque: [],
  },
  {
    command: 'token create',
    scenarios: [{ argv: ['token', 'create', '--project', 'docs', '--json'], api: { phase: 'done', runStatus: 'done' }, code: EXIT.ok }],
    opaque: ['token'],
  },
];

async function jsonKeys(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const { command, scenarios, opaque } of cases) {
    const union = new Set<string>();
    for (const scenario of scenarios) {
      const result = await run(scenario.argv, adminApi(scenario.api));
      expect(result.code, `${command}: ${result.stderr}`).toBe(scenario.code);
      // One object on one line, and nothing else on stdout: that is what `--json` promises.
      const lines = result.stdout.trim().split('\n');
      expect(lines, command).toHaveLength(1);
      for (const key of keyPaths(JSON.parse(lines[0] as string), new Set(opaque))) union.add(key);
    }
    out[command] = [...union].sort();
  }
  return out;
}

const flagsOf = (options: Record<string, { type: string; multiple?: boolean; short?: string }>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(options).map(([name, { type, multiple, short }]) => [
      name,
      { type, ...(multiple === undefined ? {} : { multiple }), ...(short === undefined ? {} : { short }) },
    ]),
  );

describe('the CLI surface is a contract', () => {
  it('records the commands, their flags, the exit codes and the keys --json prints', async () => {
    const commands: Record<string, unknown> = { backup: { arguments: 'those of scripts/backup.ts' } };
    for (const [name, options] of Object.entries(COMMAND_OPTIONS)) commands[name] = { flags: flagsOf(options) };
    // Guard the walk itself: an empty or partial map would record itself as the contract.
    expect(Object.keys(commands).sort()).toEqual(['backup', 'project create', 'project status', 'source add', 'token create']);

    await expect(recordJson({ commands, exit: EXIT, json: await jsonKeys() })).toMatchFileSnapshot(SNAPSHOT);
  });

  it('accepts every flag it records, and refuses a flag it does not know', async () => {
    for (const [name, options] of Object.entries(COMMAND_OPTIONS)) {
      const words = name.split(' ');
      for (const [flag, spec] of Object.entries(options as Record<string, { type: string; multiple?: boolean }>)) {
        const argv = [...words, `--${flag}`, ...(spec.type === 'string' ? ['x'] : []), '--help'];
        const result = await run(argv);
        expect(result.code, `${name} --${flag}: ${result.stderr}`).toBe(EXIT.ok);
      }
      expect((await run([...words, '--no-such-flag'])).code, name).toBe(EXIT.usage);
    }
  });

  it('lists in its help the commands it records, and no others', async () => {
    const help = await run(['--help']);
    const block = help.stdout.split('Commands:\n')[1]?.split('\n\n')[0] ?? '';
    const listed = block
      .split('\n')
      // The words that name the command: up to the first argument (`<…>`, `[…]`, `--…`) or the column gap.
      .map((row) => (/^ {2}(\S+(?: [a-z]+)?)/.exec(row)?.[1] ?? '').trim());
    expect(listed.sort()).toEqual(['backup', ...Object.keys(COMMAND_OPTIONS)].sort());
  });
});
