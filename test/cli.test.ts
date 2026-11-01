import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../src/cli/api-client.js';
import { parseDuration } from '../src/cli/commands.js';
import { type CliDeps, readStream, runCli } from '../src/cli/main.js';

/**
 * The `contextator` command ([ADR-0131](../.ssot/ADR.md#adr-0131)) against a stub of the admin API on a
 * loopback port: the real `fetch`, the real argument parser, and a clock that is advanced by `sleep`
 * rather than waited for, so a `--wait` that times out takes no time.
 */

const CLI_TOKEN = 'ctxk_cli-test-credential';
const GIT_TOKEN = 'ghp_git-test-credential';
const PROJECT_ID = '3f0a1c52-8d1e-4b7a-9c60-5a2f6d9e1b11';
const SERVER_VERSION = '0.0.0-test';

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

interface Reply {
  status: number;
  body?: unknown;
  /** Sent as is, for an answer that is not JSON. */
  raw?: string;
  /** Never answered, for a connection that hangs. */
  hang?: boolean;
  headers?: Record<string, string>;
}

/** A programmable stand-in for the routes the command uses. Each test sets the replies it needs. */
class StubAdmin {
  readonly calls: Call[] = [];
  /** Replies to `GET …/status`, in order; the last one repeats. */
  statuses: Reply[] = [{ status: 200, body: { project: { id: PROJECT_ID, status: 'idle' }, job: { phase: 'done', filesTotal: 3, filesDone: 3 } } }];
  runs: unknown[] = [{ id: 'run-1', status: 'done', error: null }];
  createProject: Reply = {
    status: 201,
    body: { id: PROJECT_ID, name: 'docs', mcpUrl: 'http://127.0.0.1/mcp/docs', mcpToken: { token: { id: 'tok-1' }, secret: 'ctxm_first-secret' } },
  };
  createSource: Reply = { status: 201, body: { id: 'src-1' } };
  /** The project's sources as `GET …/sources` lists them. */
  sources: unknown[] = [{ id: 'src-1' }];
  mcpToken: Reply = { status: 201, body: { token: { id: 'tok-2', name: 'ci' }, secret: 'ctxm_second-secret' } };
  list: Reply = { status: 200, body: [{ id: PROJECT_ID, name: 'docs', mcpUrl: 'http://127.0.0.1/mcp/docs', status: 'idle' }] };
  health: Reply = { status: 200, body: { ok: true, version: SERVER_VERSION } };
  private statusIndex = 0;
  private server: Server | null = null;
  private readonly hung: ServerResponse[] = [];

  /** The replies back to their defaults, on the same listening server. */
  reset(): void {
    const fresh = new StubAdmin();
    Object.assign(this, {
      statuses: fresh.statuses,
      runs: fresh.runs,
      createProject: fresh.createProject,
      createSource: fresh.createSource,
      sources: fresh.sources,
      mcpToken: fresh.mcpToken,
      list: fresh.list,
      health: fresh.health,
    });
    this.calls.length = 0;
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('the stub is not listening');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    for (const res of this.hung) res.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    const method = req.method ?? '';
    this.calls.push({ method, path, body: text ? JSON.parse(text) : undefined, authorization: req.headers.authorization });
    const reply = this.route(method, path, req.headers.authorization);
    if (reply.hang) {
      this.hung.push(res);
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
  }

  private route(method: string, path: string, authorization: string | undefined): Reply {
    if (method === 'GET' && path === '/api/health') return this.health;
    if (authorization !== `Bearer ${CLI_TOKEN}`) return { status: 401, body: { error: 'unauthorized', message: 'Sign in or send a valid token' } };
    if (method === 'POST' && path === '/api/projects') return this.createProject;
    if (method === 'GET' && path === '/api/projects') return this.list;
    if (method === 'POST' && path === `/api/projects/${PROJECT_ID}/sources`) return this.createSource;
    if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/sources`) return { status: 200, body: this.sources };
    if (method === 'POST' && path === `/api/projects/${PROJECT_ID}/mcp-tokens`) return this.mcpToken;
    if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/runs`) return { status: 200, body: { runs: this.runs } };
    if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/status`) {
      const reply = this.statuses[Math.min(this.statusIndex, this.statuses.length - 1)] as Reply;
      this.statusIndex += 1;
      return reply;
    }
    return { status: 404, body: { error: 'not_found', message: 'No such route' } };
  }

  count(method: string, path: string): number {
    return this.calls.filter((c) => c.method === method && c.path === path).length;
  }
}

const job = (phase: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    project: { id: PROJECT_ID, status: phase === 'done' || phase === 'error' ? 'idle' : 'indexing' },
    job: { phase, filesTotal: 4, filesDone: 1, ...extra },
  },
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
}

let stub: StubAdmin;

beforeEach(async () => {
  stub = new StubAdmin();
  await stub.start();
});

afterEach(async () => {
  await stub.stop();
});

/** Runs the command as the process would, with `CONTEXTATOR_URL` and `CONTEXTATOR_TOKEN` set unless overridden. */
async function run(argv: string[], overrides: Partial<CliDeps> & { env?: Record<string, string | undefined> } = {}): Promise<Outcome> {
  let stdout = '';
  let stderr = '';
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const { env: envOverrides, ...rest } = overrides;
  const deps: CliDeps = {
    env: { CONTEXTATOR_URL: stub.url, CONTEXTATOR_TOKEN: CLI_TOKEN, GIT_TOKEN, ...envOverrides },
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    readFile: () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
    readStdin: async () => {
      throw new Error('standard input was not expected to be read');
    },
    runBackup: async () => 0,
    version: SERVER_VERSION,
    ...rest,
  };
  const code = await runCli(argv, deps);
  // Neither credential is ever written to either stream, whatever happened.
  for (const secret of [CLI_TOKEN, GIT_TOKEN]) {
    expect(stdout, `stdout must not carry ${secret.slice(0, 4)}…`).not.toContain(secret);
    expect(stderr, `stderr must not carry ${secret.slice(0, 4)}…`).not.toContain(secret);
  }
  return { code, stdout, stderr, sleeps };
}

const create = ['project', 'create', 'docs', '--git', 'https://github.com/acme/handbook'];

describe('help, version and usage need no server', () => {
  const noNetwork: Partial<CliDeps> = {
    fetch: (() => {
      throw new Error('the network must not be touched');
    }) as unknown as typeof fetch,
    env: {},
  };

  it('prints help and exits 0 for --help, -h and help', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const out = await run([flag], noNetwork);
      expect(out.code).toBe(EXIT.ok);
      expect(out.stdout).toContain('Usage: contextator');
      expect(out.stdout).toContain('project create');
    }
  });

  it('prints the version and exits 0', async () => {
    const out = await run(['--version'], noNetwork);
    expect(out).toMatchObject({ code: 0, stdout: `${SERVER_VERSION}\n` });
  });

  it('prints a command’s own help after the command', async () => {
    const out = await run(['project', 'create', '--help'], noNetwork);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain('--git-token-env');
  });

  it('exits 2 with the usage on stderr when given nothing', async () => {
    const out = await run([], noNetwork);
    expect(out.code).toBe(EXIT.usage);
    expect(out.stderr).toContain('Usage: contextator');
  });
});

describe('argument parsing', () => {
  it.each([
    [['frobnicate'], /unknown command "frobnicate"/],
    [['project', 'explode'], /unknown command "project explode"/],
    [['project', 'create'], /exactly one argument/],
    [['project', 'create', 'docs'], /--git <url> is required/],
    [['project', 'create', 'docs', '--git', 'not a url'], /--git is not a URL/],
    [['project', 'create', 'docs', '--git', 'ssh://git@github.com/acme/x'], /http\(s\) URL/],
    [['project', 'create', 'docs', '--git', 'https://user:pw@github.com/acme/x'], /must not carry credentials/],
    [[...create, '--git-token-env', 'NOT_SET_ANYWHERE'], /NOT_SET_ANYWHERE, which is not set/],
    [[...create, '--timeout', 'soon'], /--timeout must be a duration/],
    [[...create, '--bogus'], /Unknown option '--bogus'/],
    [['project', 'status'], /exactly one argument/],
    [['token', 'create'], /--project <name\|id> is required/],
    [['token', 'create', '--project', 'docs'], /pass --json or --show-secret/],
    [['token', 'create', '--project', 'docs', '--json', '--expires-in-days', '7'], /30, 90 or 365/],
  ] as const)('exits 2 for %j', async (argv, message) => {
    const out = await run([...argv]);
    expect(out.code).toBe(EXIT.usage);
    expect(out.stderr).toMatch(message);
    // A usage error is decided before anything is asked of the server.
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a token given as an argument, and says where it goes', async () => {
    for (const flag of [['--token', CLI_TOKEN], [`--token=${CLI_TOKEN}`]]) {
      const out = await run([...create, ...flag]);
      expect(out.code).toBe(EXIT.usage);
      expect(out.stderr).toContain('CONTEXTATOR_TOKEN');
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('needs the server address and the token', async () => {
    const noUrl = await run(create, { env: { CONTEXTATOR_URL: undefined } });
    expect(noUrl).toMatchObject({ code: EXIT.usage });
    expect(noUrl.stderr).toContain('CONTEXTATOR_URL');
    const noToken = await run(create, { env: { CONTEXTATOR_TOKEN: undefined } });
    expect(noToken).toMatchObject({ code: EXIT.usage });
    expect(noToken.stderr).toContain('CONTEXTATOR_TOKEN');
  });

  it('rejects an address that is not http(s) or that carries credentials', async () => {
    expect((await run(create, { env: { CONTEXTATOR_URL: 'ftp://example.com' } })).code).toBe(EXIT.usage);
    expect((await run(create, { env: { CONTEXTATOR_URL: 'http://user:pw@example.com' } })).code).toBe(EXIT.usage);
    expect((await run(create, { env: { CONTEXTATOR_URL: 'nonsense' } })).code).toBe(EXIT.usage);
  });

  it('reads the token from --token-file and lets it win over the environment', async () => {
    const out = await run([...create, '--token-file', '/run/secrets/ctx', '--json'], {
      env: { CONTEXTATOR_TOKEN: 'ctxk_environment-loses' },
      readFile: (file) => {
        expect(file).toBe('/run/secrets/ctx');
        return `${CLI_TOKEN}\n`;
      },
    });
    expect(out.code).toBe(EXIT.ok);
  });

  it('reports an unreadable --token-file as usage', async () => {
    const out = await run([...create, '--token-file', '/nope']);
    expect(out.code).toBe(EXIT.usage);
    expect(out.stderr).toContain('ENOENT');
  });

  it('warns about a plain http address that is not loopback, and not about a loopback one', async () => {
    // No DNS lookup: the connection fails at once, which is all this needs.
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const remote = await run(create, { env: { CONTEXTATOR_URL: 'http://docs.example.com' }, fetch: refused });
    expect(remote.stderr).toContain('plain http');
    expect(remote.code).toBe(EXIT.unreachable);
    const local = await run(create);
    expect(local.stderr).not.toContain('plain http');
  });
});

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['45', 45_000],
  ])('reads %s', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', 'soon', '-5m', '1.5h', '0', '10d'])('refuses %j', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe('project create', () => {
  it('creates the project and its git source with the token from the variable it names', async () => {
    const out = await run([...create, '--branch', 'docs', '--subdir', 'handbook', '--git-token-env', 'GIT_TOKEN']);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/health',
      'POST /api/projects',
      `POST /api/projects/${PROJECT_ID}/sources`,
    ]);
    expect(stub.calls[1]?.body).toEqual({ name: 'docs' });
    expect(stub.calls[2]?.body).toEqual({
      type: 'git',
      name: 'docs',
      config: { url: 'https://github.com/acme/handbook', branch: 'docs', subdir: 'handbook' },
      secret: GIT_TOKEN,
      index: true,
    });
    expect(stub.calls[1]?.authorization).toBe(`Bearer ${CLI_TOKEN}`);
    expect(out.stdout).toContain('project: docs');
    expect(out.stdout).toContain(`id: ${PROJECT_ID}`);
  });

  it('sends only what was asked for: no branch, subdir or secret by default', async () => {
    await run(create);
    expect(stub.calls[2]?.body).toEqual({ type: 'git', name: 'docs', config: { url: 'https://github.com/acme/handbook' }, index: true });
  });

  it('withholds the first MCP token’s secret unless asked, and says so', async () => {
    const out = await run(create);
    expect(out.stdout).not.toContain('ctxm_first-secret');
    expect(out.stderr).toContain('secret was not printed');
  });

  it('prints the secret with --show-secret', async () => {
    const out = await run([...create, '--show-secret']);
    expect(out.stdout).toContain('mcp-token-secret: ctxm_first-secret');
    expect(out.stderr).not.toContain('not printed');
  });

  it('prints one JSON object with --json, secret included, and nothing else on stdout', async () => {
    const out = await run([...create, '--json']);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.stdout)).toEqual({
      project: { id: PROJECT_ID, name: 'docs', mcpUrl: 'http://127.0.0.1/mcp/docs' },
      mcpToken: { token: { id: 'tok-1' }, secret: 'ctxm_first-secret' },
    });
  });

  it('warns when the server is another version than the command', async () => {
    stub.health = { status: 200, body: { ok: true, version: '9.9.9' } };
    const out = await run(create);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stderr).toContain('the server is 9.9.9 and this command is 0.0.0-test');
  });

  describe('--wait', () => {
    it('follows the job to done and reports the run', async () => {
      stub.statuses = [job('queued'), job('syncing'), job('embedding'), job('done')];
      const out = await run([...create, '--wait', '--json']);
      expect(out.code).toBe(EXIT.ok);
      expect(JSON.parse(out.stdout)).toMatchObject({ project: { id: PROJECT_ID }, run: { id: 'run-1', status: 'done' } });
      expect(out.stderr).toContain('index: queued');
      expect(out.stderr).toContain('index: embedding (1/4 files)');
      // Starts at 2 s and grows by half toward a 15 s ceiling.
      expect(out.sleeps).toEqual([2000, 3000, 4500]);
    });

    it('caps the interval at 15 seconds', async () => {
      stub.statuses = [...Array.from({ length: 12 }, () => job('embedding')), job('done')];
      const out = await run([...create, '--wait']);
      expect(out.code).toBe(EXIT.ok);
      expect(Math.max(...out.sleeps)).toBe(15_000);
      expect(out.sleeps.slice(0, 6)).toEqual([2000, 3000, 4500, 6750, 10_125, 15_000]);
    });

    it('exits 5 with the run’s message when indexing fails, and still prints the result', async () => {
      stub.statuses = [job('syncing'), job('error', { error: 'git: repository not found' })];
      stub.runs = [{ id: 'run-9', status: 'error', error: 'git: repository not found' }];
      const out = await run([...create, '--wait', '--json']);
      expect(out.code).toBe(EXIT.runFailed);
      expect(out.stderr).toContain('indexing failed: git: repository not found');
      // The first token’s secret exists only in this response; a failed index must not take it with it.
      expect(JSON.parse(out.stdout)).toMatchObject({
        mcpToken: { secret: 'ctxm_first-secret' },
        run: { id: 'run-9', status: 'error', error: 'git: repository not found' },
      });
    });

    it('exits 6 on timeout, keeps the project and its source, and says how to wait again', async () => {
      stub.statuses = [job('embedding')];
      const out = await run([...create, '--wait', '--timeout', '10s', '--json']);
      expect(out.code).toBe(EXIT.timeout);
      expect(out.stderr).toContain('timed out after 10s');
      expect(out.stderr).toContain('contextator project status docs --wait');
      expect(out.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
      expect(stub.calls.every((c) => c.method !== 'DELETE')).toBe(true);
      expect(JSON.parse(out.stdout)).toMatchObject({ project: { id: PROJECT_ID }, mcpToken: { secret: 'ctxm_first-secret' } });
      expect(JSON.parse(out.stdout).run).toBeUndefined();
    });

    it('polls once more at the deadline before giving up', async () => {
      stub.statuses = [job('embedding'), job('embedding'), job('done')];
      // The sleeps are 2 s and then the 3 s that are left of 5 s; the poll that lands on the deadline still counts.
      const out = await run([...create, '--wait', '--timeout', '5s']);
      expect(out.code).toBe(EXIT.ok);
      expect(out.sleeps).toEqual([2000, 3000]);
    });

    it('survives the server restarting: a 503 is retried inside the timeout', async () => {
      stub.statuses = [job('embedding'), { status: 503, body: { error: 'unavailable', message: 'starting' } }, job('done')];
      const out = await run([...create, '--wait']);
      expect(out.code).toBe(EXIT.ok);
      expect(out.stderr).toContain('retrying');
    });

    it('does not retry a refusal that waiting cannot fix', async () => {
      stub.statuses = [job('embedding'), { status: 403, body: { error: 'forbidden', message: 'no' } }];
      const out = await run([...create, '--wait']);
      expect(out.code).toBe(EXIT.auth);
    });

    it('falls back to the newest recorded run when the server no longer remembers the job', async () => {
      stub.statuses = [{ status: 200, body: { project: { id: PROJECT_ID, status: 'idle' }, job: null } }];
      stub.runs = [{ id: 'run-7', status: 'done', error: null }];
      const out = await run([...create, '--wait', '--json']);
      expect(out.code).toBe(EXIT.ok);
      expect(JSON.parse(out.stdout).run).toEqual({ id: 'run-7', status: 'done' });
    });
  });

  describe('when the project already exists', () => {
    beforeEach(() => {
      stub.createProject = { status: 409, body: { error: 'conflict', message: 'A project named "docs" already exists' } };
    });

    it('exits 4 without --exists-ok', async () => {
      const out = await run(create);
      expect(out.code).toBe(EXIT.notFound);
      expect(out.stderr).toContain('already exists');
      expect(stub.count('POST', `/api/projects/${PROJECT_ID}/sources`)).toBe(0);
    });

    it('with --exists-ok returns it, adds no second source, and has no first token to give', async () => {
      const out = await run([...create, '--exists-ok', '--json']);
      expect(out.code).toBe(EXIT.ok);
      expect(stub.count('POST', `/api/projects/${PROJECT_ID}/sources`)).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({ project: { id: PROJECT_ID, name: 'docs', mcpUrl: 'http://127.0.0.1/mcp/docs' } });
    });

    it('with --exists-ok --wait reports the run on record', async () => {
      const out = await run([...create, '--exists-ok', '--wait', '--json']);
      expect(out.code).toBe(EXIT.ok);
      expect(JSON.parse(out.stdout).run).toEqual({ id: 'run-1', status: 'done' });
    });
  });

  it('says the project exists when its source is refused, and rolls nothing back', async () => {
    stub.createSource = { status: 400, body: { error: 'invalid_request', message: 'The git host is not allowed' } };
    const out = await run(create);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain(`project "docs" (${PROJECT_ID}) exists but its git source was not added`);
    expect(out.stderr).toContain('The git host is not allowed');
    expect(out.stderr).toContain('secret was not shown');
    expect(out.stdout).toBe('');
    expect(stub.calls.every((c) => c.method !== 'DELETE')).toBe(true);
  });

  it('still prints the first token’s secret when its source is refused and the secret was asked for', async () => {
    stub.createSource = { status: 503, body: { error: 'unavailable', message: 'try later' } };
    const out = await run([...create, '--json']);
    expect(out.code).toBe(EXIT.failure);
    expect(JSON.parse(out.stdout)).toMatchObject({ project: { id: PROJECT_ID }, mcpToken: { secret: 'ctxm_first-secret' } });
    expect(out.stderr).not.toContain('secret was not shown');
  });

  describe('retrying after the source call failed', () => {
    beforeEach(() => {
      stub.createProject = { status: 409, body: { error: 'conflict', message: 'A project named "docs" already exists' } };
      stub.sources = [];
    });

    it('--exists-ok adds the source a project is missing, then waits for the run it queued', async () => {
      stub.statuses = [job('queued'), job('done')];
      const out = await run([...create, '--exists-ok', '--wait', '--json']);
      expect(out.code).toBe(EXIT.ok);
      expect(stub.calls.find((c) => c.method === 'POST' && c.path === `/api/projects/${PROJECT_ID}/sources`)?.body).toMatchObject({
        type: 'git',
        name: 'docs',
        index: true,
      });
      expect(out.stderr).toContain('has no source; adding');
      expect(JSON.parse(out.stdout).run).toEqual({ id: 'run-1', status: 'done' });
    });
  });
});

describe('exit codes for what the server answers', () => {
  it.each([
    [401, EXIT.auth],
    [403, EXIT.auth],
    [404, EXIT.notFound],
    [409, EXIT.notFound],
    [400, EXIT.failure],
    [413, EXIT.failure],
    [500, EXIT.failure],
    [503, EXIT.failure],
  ])('maps %i to %i', async (status, code) => {
    stub.createProject = { status, body: { error: 'x', message: 'refused' } };
    const out = await run(create);
    expect(out.code).toBe(code);
    expect(out.stderr).toContain(`${status} refused`);
  });

  it('exits 3 for a credential the server does not accept', async () => {
    const out = await run(create, { env: { CONTEXTATOR_TOKEN: 'ctxk_wrong' } });
    expect(out.code).toBe(EXIT.auth);
  });

  // The credentials are checked against every stream by `run`; this drives them through the failures that
  // carry a message — a refusal, a bad source, a lost connection, a redirect — with a git token in play.
  it('never writes the API token or the git token, whichever way the command fails', async () => {
    const withGit = [...create, '--git-token-env', 'GIT_TOKEN'];
    const cases: Array<() => Promise<Outcome>> = [
      async () => {
        stub.createProject = { status: 401, body: { error: 'unauthorized', message: 'no' } };
        return run(withGit);
      },
      async () => {
        stub.createProject = { status: 301, headers: { location: 'https://elsewhere.example/' }, body: {} };
        return run(withGit);
      },
      async () => {
        stub.createSource = { status: 400, body: { error: 'invalid_request', message: 'bad source' } };
        return run([...withGit, '--json']);
      },
      async () => {
        stub.statuses = [job('error', { error: 'git: auth failed' })];
        return run([...withGit, '--wait', '--json']);
      },
      async () =>
        run(withGit, {
          fetch: (async () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))) as unknown as typeof fetch,
        }),
    ];
    for (const attempt of cases) {
      stub.reset();
      expect((await attempt()).code).not.toBe(EXIT.ok);
    }
  });

  it('gives a hung request only what is left of --timeout, not the full 30 seconds', async () => {
    stub.statuses = [{ status: 200, hang: true }];
    const started = Date.now();
    const out = await run([...create, '--wait', '--timeout', '1s']);
    expect(out.code).toBe(EXIT.timeout);
    // Two polls (the first and the one at the deadline) of one second each, nowhere near 30.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(out.stderr).toContain('retrying');
  });

  it('exits 7 when the server cannot be reached', async () => {
    const dead = new StubAdmin();
    await dead.start();
    const url = dead.url;
    await dead.stop();
    const out = await run(create, { env: { CONTEXTATOR_URL: url } });
    expect(out.code).toBe(EXIT.unreachable);
    expect(out.stderr).toContain('could not reach');
  });

  it('does not follow a redirect with the credential', async () => {
    stub.createProject = { status: 301, headers: { location: 'https://elsewhere.example/api/projects' }, body: {} };
    const out = await run(create);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('redirected to https://elsewhere.example/api/projects');
  });

  it('exits 1 for an answer that is not JSON', async () => {
    stub.list = { status: 200, raw: '<html>a captive portal</html>' };
    const out = await run(['project', 'status', 'docs']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('not JSON');
  });
});

describe('project status', () => {
  it('reports the project’s index without waiting', async () => {
    stub.statuses = [job('embedding')];
    const out = await run(['project', 'status', 'docs']);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain('index: embedding');
    expect(out.sleeps).toEqual([]);
  });

  it('finds a project by id as well as by name', async () => {
    const out = await run(['project', 'status', PROJECT_ID, '--json']);
    expect(out.code).toBe(EXIT.ok);
    expect(JSON.parse(out.stdout).project.name).toBe('docs');
  });

  it('exits 4 for a project that is not there', async () => {
    const out = await run(['project', 'status', 'ghost']);
    expect(out.code).toBe(EXIT.notFound);
    expect(out.stderr).toContain('"ghost"');
  });

  it('waits for the run in flight, then exits 0', async () => {
    stub.statuses = [job('scanning'), job('done')];
    const out = await run(['project', 'status', 'docs', '--wait']);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain('index: done');
  });

  it('exits 5 when the awaited run failed', async () => {
    stub.statuses = [job('error', { error: 'embedding provider unreachable' })];
    const out = await run(['project', 'status', 'docs', '--wait']);
    expect(out.code).toBe(EXIT.runFailed);
    expect(out.stdout).toContain('error: embedding provider unreachable');
  });

  it('exits 6 when the wait runs out', async () => {
    stub.statuses = [job('syncing')];
    const out = await run(['project', 'status', 'docs', '--wait', '--timeout', '5s']);
    expect(out.code).toBe(EXIT.timeout);
  });

  it('exits 1 rather than wait forever for a project that has never been indexed', async () => {
    stub.statuses = [{ status: 200, body: { project: { id: PROJECT_ID, status: 'idle' }, job: null } }];
    stub.runs = [];
    const out = await run(['project', 'status', 'docs', '--wait']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('nothing to wait for');
  });
});

describe('token create', () => {
  it('mints an MCP token and prints one JSON object with --json', async () => {
    const out = await run([
      'token',
      'create',
      '--project',
      'docs',
      '--name',
      'ci',
      '--expires-in-days',
      '90',
      '--allowed-cidr',
      '10.0.0.0/8',
      '--allowed-cidr',
      '192.0.2.1/32',
      '--json',
    ]);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.at(-1)?.body).toEqual({ name: 'ci', expiresInDays: 90, allowedCidrs: ['10.0.0.0/8', '192.0.2.1/32'] });
    expect(JSON.parse(out.stdout)).toEqual({
      project: { id: PROJECT_ID, name: 'docs', mcpUrl: 'http://127.0.0.1/mcp/docs' },
      token: { id: 'tok-2', name: 'ci' },
      secret: 'ctxm_second-secret',
    });
  });

  it('prints the secret as a line with --show-secret', async () => {
    const out = await run(['token', 'create', '--project', PROJECT_ID, '--show-secret']);
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain('mcp-token-secret: ctxm_second-secret');
    // Nothing optional is sent when nothing optional was asked for.
    expect(stub.calls.at(-1)?.body).toEqual({});
  });

  it('exits 4 for a project that is not there, before minting anything', async () => {
    const out = await run(['token', 'create', '--project', 'ghost', '--json']);
    expect(out.code).toBe(EXIT.notFound);
    expect(stub.count('POST', `/api/projects/${PROJECT_ID}/mcp-tokens`)).toBe(0);
  });

  it('exits 3 when the credential may not mint', async () => {
    stub.mcpToken = { status: 403, body: { error: 'forbidden', message: 'This token cannot do that' } };
    const out = await run(['token', 'create', '--project', 'docs', '--json']);
    expect(out.code).toBe(EXIT.auth);
  });
});

describe('source add', () => {
  const S3_CONFIG = { bucket: 'handbook', region: 'eu-central-1', prefix: 'docs' };
  const S3_KEYS = '{"accessKeyId":"AKIAEXAMPLE","secretAccessKey":"s3-secret-key"}';
  const sourcePath = `/api/projects/${PROJECT_ID}/sources`;
  const added = {
    id: 'src-9',
    name: 's3',
    type: 's3',
    label: null,
    hasSecret: false,
    webhookSecret: 'whsec_must-not-be-printed',
  };

  beforeEach(() => {
    stub.createSource = { status: 201, body: added };
  });

  it('sends --type and --config-json as the config of the admin API and queues an index run', async () => {
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', JSON.stringify(S3_CONFIG)]);
    expect(out.code).toBe(EXIT.ok);
    const call = stub.calls.find((c) => c.method === 'POST' && c.path === sourcePath);
    expect(call?.body).toEqual({ type: 's3', name: 's3', config: S3_CONFIG, index: true });
    expect(out.stdout).toContain('source: s3');
    expect(out.stdout).toContain('id: src-9');
    expect(out.stdout).toContain('index: queued');
    // The view the server answers with carries a webhook secret; it is not echoed.
    expect(out.stdout + out.stderr).not.toContain('whsec_');
  });

  it('prints a trimmed JSON object with --json, and takes --name and --label', async () => {
    const out = await run([
      'source',
      'add',
      '--project',
      PROJECT_ID,
      '--type',
      's3',
      '--name',
      'bucket',
      '--label',
      'Bucket',
      '--config-json',
      '{}',
      '--json',
    ]);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.find((c) => c.path === sourcePath && c.method === 'POST')?.body).toEqual({
      type: 's3',
      name: 'bucket',
      label: 'Bucket',
      config: {},
      index: true,
    });
    expect(JSON.parse(out.stdout)).toEqual({
      project: { id: PROJECT_ID, name: 'docs' },
      source: { id: 'src-9', name: 's3', type: 's3', label: null, hasSecret: false },
      index: 'queued',
    });
  });

  it('reads the config from --config-file', async () => {
    const readFile = (file: string) => {
      expect(file).toBe('/etc/ctx/s3.json');
      return JSON.stringify(S3_CONFIG);
    };
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-file', '/etc/ctx/s3.json'], { readFile });
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.find((c) => c.path === sourcePath && c.method === 'POST')?.body).toMatchObject({ config: S3_CONFIG });
  });

  it('reads the config from standard input with --config-file -', async () => {
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-file', '-'], {
      readStdin: async () => JSON.stringify(S3_CONFIG),
    });
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.find((c) => c.path === sourcePath && c.method === 'POST')?.body).toMatchObject({ config: S3_CONFIG });
  });

  it('sends the credential from --secret-env as the secret and never prints it', async () => {
    const fromEnv = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '{}', '--secret-env', 'S3_KEYS'], {
      env: { S3_KEYS },
    });
    expect(fromEnv.code).toBe(EXIT.ok);
    expect(stub.calls.find((c) => c.path === sourcePath && c.method === 'POST')?.body).toMatchObject({ secret: S3_KEYS });
    expect(fromEnv.stdout + fromEnv.stderr).not.toContain('s3-secret-key');
  });

  it('exits 2 for invalid JSON, without quoting it and without calling the source route', async () => {
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '{"secretAccessKey":"oops-leak']);
    expect(out.code).toBe(EXIT.usage);
    expect(out.stderr).toContain('--config-json is not valid JSON');
    expect(out.stderr).not.toContain('oops-leak');
    expect(stub.count('POST', sourcePath)).toBe(0);
  });

  it('exits 2 for a config that is not an object, from a file that cannot be read, and for conflicting options', async () => {
    const notObject = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '[1]']);
    expect(notObject.code).toBe(EXIT.usage);
    expect(notObject.stderr).toContain('must be a JSON object');

    const missing = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-file', '/nope.json']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toContain('(ENOENT)');

    const badFileJson = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-file', 'c.json'], { readFile: () => '{nope' });
    expect(badFileJson.stderr).toContain('--config-file is not valid JSON');

    const both = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '{}', '--config-file', 'c.json']);
    expect(both.code).toBe(EXIT.usage);

    const secretFile = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--secret-file', '/run/secrets/s3']);
    expect(secretFile.code).toBe(EXIT.usage);

    const noEnv = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--secret-env', 'UNSET_VAR']);
    expect(noEnv.code).toBe(EXIT.usage);
    expect(noEnv.stderr).toContain('UNSET_VAR');
    expect(stub.count('POST', sourcePath)).toBe(0);
  });

  it('exits 2 without --project or --type, and for a stray argument', async () => {
    expect((await run(['source', 'add', '--type', 's3'])).code).toBe(EXIT.usage);
    expect((await run(['source', 'add', '--project', 'docs'])).code).toBe(EXIT.usage);
    expect((await run(['source', 'add', '--project', 'docs', '--type', 's3', 'extra'])).code).toBe(EXIT.usage);
    expect((await run(['source', 'add', '--project', 'docs', '--type', 'S3 bucket'])).code).toBe(EXIT.usage);
  });

  it("prints the server's validation message and exits 1", async () => {
    stub.createSource = {
      status: 400,
      body: { error: 'validation_failed', message: '✖ Invalid input: expected string, received number\n  → at config.bucket', issues: [] },
    };
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '{"bucket":1}']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('400');
    expect(out.stderr).toContain('at config.bucket');
  });

  it('exits 3 when the credential may not add sources, and 4 for a project that is not there', async () => {
    stub.createSource = { status: 403, body: { error: 'forbidden', message: 'This token cannot do that' } };
    expect((await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-json', '{}'])).code).toBe(EXIT.auth);
    expect((await run(['source', 'add', '--project', 'ghost', '--type', 's3', '--config-json', '{}'])).code).toBe(EXIT.notFound);
  });

  it('exits 2 when standard input cannot be read, naming why and not the content', async () => {
    const out = await run(['source', 'add', '--project', 'docs', '--type', 's3', '--config-file', '-'], {
      readStdin: async () => {
        throw new CliError('standard input is a terminal; pipe the content in', EXIT.usage);
      },
    });
    expect(out.code).toBe(EXIT.usage);
    expect(out.stderr).toContain('standard input is a terminal');
    expect(stub.count('POST', sourcePath)).toBe(0);
  });

  it('--help lists the new options and needs no server', async () => {
    const out = await run(['source', 'add', '--help'], { env: {} });
    expect(out.code).toBe(EXIT.ok);
    for (const flag of ['--type', '--config-json', '--config-file', '--secret-env', '--project']) expect(out.stdout).toContain(flag);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('readStream (standard input)', () => {
  const chunks = async function* (...parts: (Buffer | string)[]) {
    for (const part of parts) yield part;
  };

  it('reads a pipe to the end', async () => {
    expect(await readStream(chunks('{"a":', Buffer.from('1}')))).toBe('{"a":1}');
  });

  it('refuses a terminal instead of waiting on it', async () => {
    const terminal = Object.assign(chunks('never read'), { isTTY: true });
    await expect(readStream(terminal)).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('terminal') });
  });

  it('refuses more than the cap, and accepts exactly the cap', async () => {
    await expect(readStream(chunks(Buffer.alloc(6), Buffer.alloc(6)), 10)).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: expect.stringContaining('larger than'),
    });
    expect(await readStream(chunks(Buffer.alloc(5, 97), Buffer.alloc(5, 98)), 10)).toBe('aaaaabbbbb');
  });
});

describe('token create --source', () => {
  const SOURCE_ID = '9b1d2c3e-4f5a-4b6c-8d7e-0123456789ab';

  it('binds the token to one source by name', async () => {
    const out = await run(['token', 'create', '--project', 'docs', '--source', 'handbook', '--json']);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.at(-1)?.body).toEqual({ sources: ['handbook'] });
    // A name needs no lookup: the server resolves it.
    expect(stub.count('GET', `/api/projects/${PROJECT_ID}/sources`)).toBe(0);
  });

  it('binds the token to two sources and lists them in the text output', async () => {
    const out = await run(['token', 'create', '--project', 'docs', '--source', 'handbook', '--source', 'wiki', '--show-secret']);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.at(-1)?.body).toEqual({ sources: ['handbook', 'wiki'] });
    expect(out.stdout).toContain('sources: handbook, wiki');
    expect(out.stdout).toContain('mcp-token-secret: ctxm_second-secret');
  });

  it('turns a source id into the name the API takes, and drops a repeat', async () => {
    stub.sources = [
      { id: SOURCE_ID, name: 'handbook' },
      { id: 'other', name: 'wiki' },
    ];
    const out = await run(['token', 'create', '--project', 'docs', '--source', SOURCE_ID, '--source', 'handbook', '--json']);
    expect(out.code).toBe(EXIT.ok);
    expect(stub.calls.at(-1)?.body).toEqual({ sources: ['handbook'] });
  });

  it("exits 1 with the server's message for a source the project does not have", async () => {
    stub.mcpToken = { status: 400, body: { error: 'unknown_source', message: 'This project has no source named: ghost.' } };
    const out = await run(['token', 'create', '--project', 'docs', '--source', 'ghost', '--json']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('This project has no source named: ghost.');
    expect(out.stdout).toBe('');
  });

  it('sends an id that matches nothing as it was written, so the server names it', async () => {
    stub.sources = [{ id: 'other', name: 'wiki' }];
    stub.mcpToken = { status: 400, body: { error: 'unknown_source', message: `This project has no source named: ${SOURCE_ID}.` } };
    const out = await run(['token', 'create', '--project', 'docs', '--source', SOURCE_ID, '--json']);
    expect(out.code).toBe(EXIT.failure);
    expect(stub.calls.at(-1)?.body).toEqual({ sources: [SOURCE_ID] });
    expect(out.stderr).toContain(SOURCE_ID);
  });

  it('keeps the other options beside --source and lists --source in --help', async () => {
    await run(['token', 'create', '--project', 'docs', '--name', 'ci', '--source', 'handbook', '--allowed-cidr', '10.0.0.0/8', '--json']);
    expect(stub.calls.at(-1)?.body).toEqual({ name: 'ci', sources: ['handbook'], allowedCidrs: ['10.0.0.0/8'] });
    const help = await run(['token', 'create', '--help'], { env: {} });
    expect(help.stdout).toContain('--source');
  });
});

describe('backup', () => {
  it('hands every argument, untouched, to the backup script and returns its exit code', async () => {
    const seen: string[][] = [];
    const out = await run(['backup', '/data/out.tar.gz', '--keep', '7', '--json'], {
      env: {},
      fetch: (() => {
        throw new Error('backup does not use the admin API');
      }) as unknown as typeof fetch,
      runBackup: async (args) => {
        seen.push(args);
        return 3;
      },
    });
    expect(seen).toEqual([['/data/out.tar.gz', '--keep', '7', '--json']]);
    expect(out.code).toBe(3);
  });
});

describe('process-level behaviour', () => {
  it('never throws out of runCli: an answer of the wrong shape is exit 1 with its cause', async () => {
    stub.list = { status: 200, body: { not: 'a list' } };
    const out = await run(['project', 'status', 'docs']);
    expect(out.code).toBe(EXIT.failure);
    expect(out.stderr).toContain('unexpected error');
  });
});
