import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_VERSION } from '../version.js';
import { ApiClient, CliError, EXIT } from './api-client.js';
import { type CliIo, type CommandContext, DEFAULT_WAIT_TIMEOUT_MS, parseDuration, projectCreate, projectStatus, tokenCreate } from './commands.js';

/**
 * `contextator` — the admin API from a shell or a CI job, and the existing backup under the same name
 * ([ADR-0131](../../.ssot/ADR.md#adr-0131)). It ships in the image and is published nowhere (D17).
 *
 * The environment is read here, from the `env` the entry point hands in, and nowhere else in `src/cli/`.
 * That is deliberate and different from the server's rule that only `src/config.ts` reads it: this
 * command has its own two variables and must not import the server's validation.
 */

const USAGE = `Usage: contextator <command> [options]

Commands:
  project create <name> --git <url>   Create a project with a git source
  project status <name|id>            Show where a project's index stands
  token create --project <name|id>    Mint an MCP token for a project
  backup [args]                       Run the backup (needs database access; full image only)

Connection (every command except backup):
  CONTEXTATOR_URL      Address of the server, e.g. https://docs.example.com (or --url)
  CONTEXTATOR_TOKEN    An API token or ADMIN_TOKEN (or --token-file <path>); never an argument

Options:
  --json               Print the result as one JSON object on stdout
  -h, --help           Show this help (also after a command)
  -v, --version        Show the version

Exit codes: 0 ok, 1 error, 2 usage, 3 not authorised, 4 not found or conflict,
            5 the awaited index run failed, 6 --wait timed out, 7 server unreachable
`;

const COMMAND_USAGE: Record<string, string> = {
  'project create': `Usage: contextator project create <name> --git <url> [options]

Creates the project, adds a git source of the same name and queues its first index run.

  --git <url>             Repository URL (https), without credentials in it
  --branch <name>         Branch to index (the server's default is main)
  --subdir <path>         Index only this directory of the repository
  --git-token-env <VAR>   Name of the environment variable that holds the git token
  --wait                  Wait for the index run to end
  --timeout <duration>    Longest --wait, e.g. 90s, 15m, 1h (default 15m)
  --exists-ok             A project with this name already existing is not an error
  --json                  Print one JSON object: { project, mcpToken?, run? }
  --show-secret           Print the project's first MCP token secret (also printed with --json)
  --url <url>             Server address instead of CONTEXTATOR_URL
  --token-file <path>     Read the token from a file instead of CONTEXTATOR_TOKEN
`,
  'project status': `Usage: contextator project status <name|id> [options]

  --wait                  Wait for the index run in flight to end
  --timeout <duration>    Longest --wait, e.g. 90s, 15m, 1h (default 15m)
  --json                  Print one JSON object
  --url <url>             Server address instead of CONTEXTATOR_URL
  --token-file <path>     Read the token from a file instead of CONTEXTATOR_TOKEN
`,
  'token create': `Usage: contextator token create --project <name|id> (--json | --show-secret) [options]

Mints an MCP token. Its secret exists only in this answer, so one of --json and --show-secret is required.

  --project <name|id>     The project the token opens
  --name <text>           A label for the token
  --expires-in-days <n>   30, 90 or 365 (default: never)
  --allowed-cidr <cidr>   Network allowed to present the token; repeat for several
  --url <url>             Server address instead of CONTEXTATOR_URL
  --token-file <path>     Read the token from a file instead of CONTEXTATOR_TOKEN
`,
};

export interface CliDeps {
  /** What the process was started with; the entry point passes `process.env`. */
  env: Record<string, string | undefined>;
  io: CliIo;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readFile: (file: string) => string;
  /** Runs `scripts/backup.ts` with these arguments and resolves to its exit code. */
  runBackup: (args: string[]) => Promise<number>;
  version: string;
}

/** Options every API command takes. */
const COMMON_OPTIONS = {
  url: { type: 'string' },
  'token-file': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const usageError = (message: string): CliError => new CliError(message, EXIT.usage);

/** `parseArgs` over a command's options, its failures reported as usage errors. */
function parse<const O extends Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A token on the command line shows in the process list and in shell history. Say so rather than
    // only that the option is unknown.
    if (/--token\b(?!-file)/.test(message))
      throw usageError('the token is never taken as an argument; set CONTEXTATOR_TOKEN or use --token-file <path>');
    throw usageError(message.replace(/\s*To specify a positional argument starting with a '-'.*$/s, ''));
  }
}

const isLoopbackHost = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);

interface Connection {
  baseUrl: string;
  token: string;
  warnings: string[];
}

/** The server address and the credential, from the flags and then the environment. Nothing here is printed. */
function connectionFrom(values: { url?: string; 'token-file'?: string }, deps: CliDeps): Connection {
  const rawUrl = values.url ?? deps.env.CONTEXTATOR_URL;
  if (!rawUrl) throw usageError('the server address is missing: set CONTEXTATOR_URL or pass --url');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw usageError('the server address is not a URL (expected e.g. https://docs.example.com)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw usageError('the server address must start with http:// or https://');
  if (url.username || url.password) throw usageError('the server address must not carry credentials; the token goes in CONTEXTATOR_TOKEN');
  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;

  let token: string | undefined;
  if (values['token-file'] !== undefined) {
    try {
      token = deps.readFile(values['token-file']).trim();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw usageError(`could not read the token file ${values['token-file']}${typeof code === 'string' ? ` (${code})` : ''}`);
    }
  } else {
    token = deps.env.CONTEXTATOR_TOKEN?.trim();
  }
  if (!token) throw usageError('the token is missing: set CONTEXTATOR_TOKEN or pass --token-file <path>');
  // A line break would be a second header; fetch refuses it with a message that quotes the value.
  if (/[\r\n]/.test(token)) throw usageError('the token must be a single line');

  const warnings: string[] = [];
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    warnings.push(`warning: ${url.origin} is plain http, so the token travels unencrypted`);
  }
  return { baseUrl, token, warnings };
}

async function runApiCommand(command: 'project create' | 'project status' | 'token create', rest: string[], deps: CliDeps): Promise<number> {
  const { io } = deps;
  const help = COMMAND_USAGE[command] ?? USAGE;

  if (command === 'project create') {
    const { values, positionals } = parse(rest, {
      ...COMMON_OPTIONS,
      git: { type: 'string' },
      branch: { type: 'string' },
      subdir: { type: 'string' },
      'git-token-env': { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      'exists-ok': { type: 'boolean' },
      'show-secret': { type: 'boolean' },
    });
    if (values.help) {
      io.stdout(help);
      return EXIT.ok;
    }
    const [name, ...extra] = positionals;
    if (!name || extra.length > 0) throw usageError('project create takes exactly one argument, the project name');
    if (!values.git) throw usageError('--git <url> is required');
    let gitUrl: URL;
    try {
      gitUrl = new URL(values.git);
    } catch {
      throw usageError('--git is not a URL');
    }
    if (gitUrl.protocol !== 'https:' && gitUrl.protocol !== 'http:') throw usageError('--git must be an http(s) URL');
    if (gitUrl.username || gitUrl.password) {
      throw usageError(
        '--git must not carry credentials (they would show in the process list); put the token in a variable and pass --git-token-env <VAR>',
      );
    }
    let gitToken: string | undefined;
    if (values['git-token-env'] !== undefined) {
      gitToken = deps.env[values['git-token-env']];
      if (!gitToken) throw usageError(`--git-token-env names ${values['git-token-env']}, which is not set or is empty`);
    }
    const timeoutMs = timeoutFrom(values.timeout);
    const connection = connectionFrom(values, deps);
    const ctx = await contextFor(connection, deps, values.json === true, values['show-secret'] === true);
    return projectCreate(ctx, {
      name,
      gitUrl: values.git,
      branch: values.branch,
      subdir: values.subdir,
      gitToken,
      wait: values.wait === true,
      timeoutMs,
      existsOk: values['exists-ok'] === true,
    });
  }

  if (command === 'project status') {
    const { values, positionals } = parse(rest, { ...COMMON_OPTIONS, wait: { type: 'boolean' }, timeout: { type: 'string' } });
    if (values.help) {
      io.stdout(help);
      return EXIT.ok;
    }
    const [ref, ...extra] = positionals;
    if (!ref || extra.length > 0) throw usageError('project status takes exactly one argument, a project name or id');
    const timeoutMs = timeoutFrom(values.timeout);
    const ctx = await contextFor(connectionFrom(values, deps), deps, values.json === true, false);
    return projectStatus(ctx, { ref, wait: values.wait === true, timeoutMs });
  }

  const { values, positionals } = parse(rest, {
    ...COMMON_OPTIONS,
    project: { type: 'string' },
    name: { type: 'string' },
    'expires-in-days': { type: 'string' },
    'allowed-cidr': { type: 'string', multiple: true },
    'show-secret': { type: 'boolean' },
  });
  if (values.help) {
    io.stdout(help);
    return EXIT.ok;
  }
  if (positionals.length > 0) throw usageError('token create takes no positional arguments');
  if (!values.project) throw usageError('--project <name|id> is required');
  // Refused before the call: a token minted and not printed could never be read again.
  if (!values.json && !values['show-secret']) {
    throw usageError('a token secret is shown once and only on request: pass --json or --show-secret (nothing was created)');
  }
  let expiresInDays: number | undefined;
  if (values['expires-in-days'] !== undefined) {
    expiresInDays = Number(values['expires-in-days']);
    if (![30, 90, 365].includes(expiresInDays)) throw usageError('--expires-in-days must be 30, 90 or 365');
  }
  const ctx = await contextFor(connectionFrom(values, deps), deps, values.json === true, true);
  return tokenCreate(ctx, { project: values.project, name: values.name, expiresInDays, allowedCidrs: values['allowed-cidr'] ?? [] });
}

function timeoutFrom(text: string | undefined): number {
  if (text === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  const ms = parseDuration(text);
  if (ms === null) throw usageError('--timeout must be a duration such as 90s, 15m or 1h');
  return ms;
}

/** Builds the client, reaches the server once, and warns when it is not the version this command shipped with. */
async function contextFor(connection: Connection, deps: CliDeps, json: boolean, showSecret: boolean): Promise<CommandContext> {
  for (const warning of connection.warnings) deps.io.stderr(`${warning}\n`);
  const client = new ApiClient({ baseUrl: connection.baseUrl, token: connection.token, fetch: deps.fetch });
  const { version } = await client.health();
  if (version && version !== deps.version) {
    // The admin API is not versioned; a command and a server from different releases are outside the contract (ADR-0131).
    deps.io.stderr(`warning: the server is ${version} and this command is ${deps.version}; use the same image tag for both\n`);
  }
  return { client, io: deps.io, sleep: deps.sleep, now: deps.now, json, showSecret };
}

/** Runs one invocation and returns its exit code. Nothing here calls `process.exit`, so tests can run it. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { io } = deps;
  try {
    const [first, second, ...after] = argv;
    if (first === undefined) {
      io.stderr(USAGE);
      return EXIT.usage;
    }
    if (first === '--help' || first === '-h' || first === 'help') {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    if (first === '--version' || first === '-v') {
      io.stdout(`${deps.version}\n`);
      return EXIT.ok;
    }
    if (first === 'backup') return await deps.runBackup(argv.slice(1));
    if (first === 'project' && (second === 'create' || second === 'status')) return await runApiCommand(`project ${second}`, after, deps);
    if (first === 'token' && second === 'create') return await runApiCommand('token create', after, deps);
    if ((first === 'project' || first === 'token') && (second === '--help' || second === '-h')) {
      io.stdout(USAGE);
      return EXIT.ok;
    }
    if ((first === 'project' || first === 'token') && second === undefined) {
      io.stderr(USAGE);
      return EXIT.usage;
    }
    throw usageError(
      `unknown command "${[first, second].filter((part) => part !== undefined && !part.startsWith('-')).join(' ')}"; try: contextator --help`,
    );
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`contextator: ${err.message}\n`);
      return err.exitCode;
    }
    // Not a message of ours: the cause, once, without a stack that could quote a request.
    io.stderr(`contextator: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failure;
  }
}

/**
 * `backup` is the one command that is not the admin API: it runs `scripts/backup.ts` as `npm run backup`
 * does, with the arguments as given, so there is still one backup and one place that defines it
 * (ADR-0131 decision 3, ADR-0072). It needs the database and `pg_dump`, which only the full image has;
 * the script says so itself when `pg_dump` is missing.
 */
function backupInChildProcess(args: string[]): Promise<number> {
  const require = createRequire(import.meta.url);
  // src/cli/ under tsx and dist/cli/ under node are both two levels below the package root, which holds scripts/.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tsx = require.resolve('tsx/cli');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, path.join(packageRoot, 'scripts', 'backup.ts'), ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write(`contextator: could not start the backup: ${err.message}\n`);
      resolve(EXIT.failure);
    });
    // A child killed by a signal exits as a shell reports it: 128 plus the signal number (SIGTERM is 143).
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : EXIT.failure)));
  });
}

/** One invocation with the process's own environment, streams and clock; `src/cli.ts` is the only caller. */
export function main(argv: string[]): Promise<number> {
  return runCli(argv, {
    env: process.env,
    io: { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readFile: (file) => readFileSync(file, 'utf8'),
    runBackup: backupInChildProcess,
    version: APP_VERSION,
  });
}
