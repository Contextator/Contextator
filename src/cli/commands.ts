import { type ApiClient, CliError, EXIT, REQUEST_TIMEOUT_MS } from './api-client.js';

/**
 * The commands of [ADR-0131](../../.ssot/ADR.md#adr-0131) that talk to the admin API. Progress goes to
 * stderr and the result to stdout, so `docs=$(contextator project create … --json)` captures the result
 * and nothing else.
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** What a command needs besides the client. `sleep` and `now` are injected so a wait is testable without waiting. */
export interface CommandContext {
  client: ApiClient;
  io: CliIo;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** `--json`: the result is one JSON object on stdout. */
  json: boolean;
  /** `--show-secret`: an MCP token's secret may be written to stdout. */
  showSecret: boolean;
}

/** Index job phases that mean the run is still going (`JobPhase` in `src/services/indexer.ts`, minus `done` and `error`). */
const ACTIVE_PHASES: ReadonlySet<string> = new Set(['queued', 'syncing', 'scanning', 'embedding', 'finalizing']);

/** First poll after 2 seconds, growing by half each time to a 15 second ceiling (ADR-0131 design). */
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 15_000;
const POLL_GROWTH = 1.5;

export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

interface ProjectView {
  id: string;
  name: string;
  mcpUrl: string;
  status?: string;
  lastIndexedAt?: string | null;
  lastError?: string | null;
}

interface JobView {
  phase: string;
  filesTotal?: number;
  filesDone?: number;
  error?: string;
}

interface RunView {
  id: string;
  status: string;
  error?: string | null;
}

interface CreatedProject extends ProjectView {
  mcpToken: { token: unknown; secret: string } | null;
}

interface McpTokenResponse {
  token: unknown;
  secret: string;
}

const line = (text: string): string => `${text}\n`;

/** `15m`, `90s`, `2h` or a bare number of seconds, as milliseconds. `null` when it is none of those. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*([smh]?)$/.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : 1_000;
  const ms = amount * unit;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

const formatDuration = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project by name or id, through the list the caller is allowed to see. */
async function resolveProject(client: ApiClient, ref: string): Promise<ProjectView> {
  const projects = await client.request<ProjectView[]>('GET', '/api/projects');
  const found = projects.find((p) => p.name === ref) ?? (UUID.test(ref) ? projects.find((p) => p.id === ref) : undefined);
  if (!found) throw new CliError(`no project named or identified "${ref}" is visible to this credential`, EXIT.notFound);
  return found;
}

type WaitOutcome =
  | { state: 'done'; run: RunView | null }
  | { state: 'error'; run: RunView | null; error: string }
  | { state: 'timeout'; lastIssue: string | null };

/**
 * Polls the project until its index run ends. The live job is the answer while the server remembers it;
 * once it does not (a restart, or a project nobody has indexed) the newest recorded run is.
 *
 * A network failure or a gateway error inside the window is retried: a server that restarts during a
 * long index is the case a CI job most needs to survive. Anything else (a `401`, a `404`) ends the wait.
 * `expectRun` is whether the caller just queued a run, in which case "nothing on record yet" is waited
 * out rather than reported.
 */
async function waitForIndex(ctx: CommandContext, projectId: string, options: { timeoutMs: number; expectRun: boolean }): Promise<WaitOutcome> {
  const { client, io } = ctx;
  const deadline = ctx.now() + options.timeoutMs;
  let delay = POLL_FIRST_MS;
  let lastIssue: string | null = null;
  let lastShown = '';
  // A request may not outlive what is left of the wait (a floor of one second lets the poll at the deadline happen).
  const budget = () => ({ timeoutMs: Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - ctx.now())) });
  const latestRun = async (): Promise<RunView | null> =>
    (await client.request<{ runs: RunView[] }>('GET', `/api/projects/${projectId}/runs`, undefined, budget())).runs[0] ?? null;

  for (;;) {
    try {
      const snapshot = await client.request<{ project: ProjectView; job: JobView | null }>(
        'GET',
        `/api/projects/${projectId}/status`,
        undefined,
        budget(),
      );
      const job = snapshot.job;
      lastIssue = null;
      if (job && ACTIVE_PHASES.has(job.phase)) {
        const shown = `${job.phase} ${job.filesDone ?? 0}/${job.filesTotal ?? 0}`;
        if (shown !== lastShown) {
          io.stderr(line(`index: ${job.phase}${job.filesTotal ? ` (${job.filesDone ?? 0}/${job.filesTotal} files)` : ''}`));
          lastShown = shown;
        }
      } else if (job?.phase === 'done') {
        return { state: 'done', run: await latestRun() };
      } else if (job?.phase === 'error') {
        return { state: 'error', run: await latestRun(), error: job.error ?? snapshot.project.lastError ?? 'the index run failed' };
      } else if (snapshot.project.status !== 'indexing') {
        const run = await latestRun();
        if (run?.status === 'done') return { state: 'done', run };
        if (run?.status === 'error') return { state: 'error', run, error: run.error ?? 'the index run failed' };
        if (!options.expectRun) throw new CliError('no index run is on record for this project, so there is nothing to wait for', EXIT.failure);
      }
    } catch (err) {
      if (!(err instanceof CliError && err.transient)) throw err;
      lastIssue = err.message;
      io.stderr(line(`index: ${err.message}; retrying`));
    }
    const remaining = deadline - ctx.now();
    if (remaining <= 0) return { state: 'timeout', lastIssue };
    await ctx.sleep(Math.min(delay, remaining));
    delay = Math.min(Math.round(delay * POLL_GROWTH), POLL_MAX_MS);
  }
}

export interface ProjectCreateOptions {
  name: string;
  gitUrl: string;
  branch?: string;
  subdir?: string;
  /** The git token itself, read by the caller from the environment variable the operator named. */
  gitToken?: string;
  wait: boolean;
  timeoutMs: number;
  existsOk: boolean;
}

interface CreateResult {
  project: { id: string; name: string; mcpUrl: string };
  mcpToken?: { token: unknown; secret?: string };
  run?: { id: string | null; status: string; error?: string };
}

const WITHHELD_SECRET_NOTE =
  "the project's first MCP token was issued and its secret was not printed (it exists nowhere else); pass --show-secret or --json to print it, or mint another with `contextator token create`";

/** Writes a result: one JSON object with `--json`, otherwise `key: value` lines. The secret only when allowed. */
function emitCreate(ctx: CommandContext, result: CreateResult, secret: string | undefined): void {
  const printSecret = ctx.json || ctx.showSecret;
  if (ctx.json) {
    const out: CreateResult = { ...result };
    if (result.mcpToken) out.mcpToken = { token: result.mcpToken.token, secret };
    ctx.io.stdout(line(JSON.stringify(out)));
  } else {
    ctx.io.stdout(line(`project: ${result.project.name}`));
    ctx.io.stdout(line(`id: ${result.project.id}`));
    ctx.io.stdout(line(`mcp-url: ${result.project.mcpUrl}`));
    if (result.mcpToken && printSecret && secret) ctx.io.stdout(line(`mcp-token-secret: ${secret}`));
    if (result.run) ctx.io.stdout(line(`index: ${result.run.status}`));
  }
  if (result.mcpToken && !printSecret) ctx.io.stderr(line(WITHHELD_SECRET_NOTE));
}

/** `project create <name> --git <url>`: the project, its git source, and with `--wait` its first index run. */
export async function projectCreate(ctx: CommandContext, options: ProjectCreateOptions): Promise<number> {
  const { client, io } = ctx;
  let project: ProjectView;
  let secret: string | undefined;
  let mcpToken: CreateResult['mcpToken'];
  let created = true;
  try {
    const body = await client.request<CreatedProject>('POST', '/api/projects', { name: options.name });
    project = body;
    // Returned once, at creation, and only when the project was born requiring a token (ADR-0065).
    if (body.mcpToken) {
      secret = body.mcpToken.secret;
      mcpToken = { token: body.mcpToken.token };
    }
  } catch (err) {
    if (!(options.existsOk && err instanceof CliError && err.exitCode === EXIT.notFound && /already exists/i.test(err.message))) throw err;
    // `--exists-ok`: the project is the one asked for. It has its source already and no first token to hand over.
    created = false;
    project = await resolveProject(client, options.name);
    io.stderr(line(`project "${options.name}" already exists`));
  }

  const result: CreateResult = { project: { id: project.id, name: project.name, mcpUrl: project.mcpUrl } };
  if (mcpToken) result.mcpToken = mcpToken;

  // A project that exists but has no source is one an earlier run created and could not finish (the source call
  // failed after the project call succeeded). It is completed here rather than left to fail every run after.
  let needsSource = created;
  if (!created) {
    const sources = await client.request<unknown[]>('GET', `/api/projects/${project.id}/sources`);
    needsSource = sources.length === 0;
    if (needsSource) io.stderr(line(`project "${options.name}" has no source; adding the git source`));
  }

  if (needsSource) {
    const config: Record<string, string> = { url: options.gitUrl };
    if (options.branch) config.branch = options.branch;
    if (options.subdir) config.subdir = options.subdir;
    try {
      await client.request('POST', `/api/projects/${project.id}/sources`, {
        type: 'git',
        name: options.name,
        config,
        ...(options.gitToken ? { secret: options.gitToken } : {}),
        // Queues the first run in the same call, so `--wait` has a run to wait for.
        index: true,
      });
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      // Nothing is rolled back: half-deleting would be worse than a project that is there to retry on, and a retry with
      // `--exists-ok` adds the source. The first token's secret exists only in this process: it is printed when the
      // caller asked for it, as a failed wait does, and otherwise said to be lost.
      const printed = Boolean(mcpToken) && (ctx.json || ctx.showSecret);
      if (printed) emitCreate(ctx, result, secret);
      const orphan = `project "${options.name}" (${project.id}) exists but its git source was not added: ${err.message}`;
      throw new CliError(mcpToken && !printed ? `${orphan}. Its first MCP token secret was not shown.` : orphan, err.exitCode, false);
    }
  }

  if (!options.wait) {
    emitCreate(ctx, result, secret);
    return EXIT.ok;
  }

  let outcome: WaitOutcome;
  try {
    outcome = await waitForIndex(ctx, project.id, { timeoutMs: options.timeoutMs, expectRun: needsSource });
  } catch (err) {
    // The one-time secret must not be lost to a failed wait.
    emitCreate(ctx, result, secret);
    throw err;
  }
  if (outcome.state === 'timeout') {
    emitCreate(ctx, result, secret);
    io.stderr(
      line(
        `timed out after ${formatDuration(options.timeoutMs)} waiting for the index${outcome.lastIssue ? ` (last problem: ${outcome.lastIssue})` : ''}; ` +
          `the project and its source were kept. Wait again with: contextator project status ${project.name} --wait`,
      ),
    );
    return EXIT.timeout;
  }
  result.run = { id: outcome.run?.id ?? null, status: outcome.state };
  if (outcome.state === 'error') result.run.error = outcome.error;
  emitCreate(ctx, result, secret);
  if (outcome.state === 'error') {
    io.stderr(line(`indexing failed: ${outcome.error}`));
    return EXIT.runFailed;
  }
  return EXIT.ok;
}

export interface ProjectStatusOptions {
  ref: string;
  wait: boolean;
  timeoutMs: number;
}

/** `project status <name|id>`: where the project's index stands, optionally waiting for the run in flight. */
export async function projectStatus(ctx: CommandContext, options: ProjectStatusOptions): Promise<number> {
  const { client, io } = ctx;
  const project = await resolveProject(client, options.ref);
  let run: RunView | null = null;
  let error: string | undefined;
  let state: string;
  if (options.wait) {
    const outcome = await waitForIndex(ctx, project.id, { timeoutMs: options.timeoutMs, expectRun: false });
    if (outcome.state === 'timeout') {
      io.stderr(
        line(
          `timed out after ${formatDuration(options.timeoutMs)} waiting for the index${outcome.lastIssue ? ` (last problem: ${outcome.lastIssue})` : ''}`,
        ),
      );
      return EXIT.timeout;
    }
    state = outcome.state;
    run = outcome.run;
    if (outcome.state === 'error') error = outcome.error;
  } else {
    const snapshot = await client.request<{ project: ProjectView; job: JobView | null }>('GET', `/api/projects/${project.id}/status`);
    run = (await client.request<{ runs: RunView[] }>('GET', `/api/projects/${project.id}/runs`)).runs[0] ?? null;
    state = snapshot.job?.phase ?? run?.status ?? 'none';
    if (state === 'error') error = snapshot.job?.error ?? run?.error ?? snapshot.project.lastError ?? undefined;
  }
  if (ctx.json) {
    ctx.io.stdout(
      line(
        JSON.stringify({
          project: { id: project.id, name: project.name, mcpUrl: project.mcpUrl },
          index: { state, ...(error ? { error } : {}) },
          ...(run ? { run: { id: run.id, status: run.status } } : {}),
        }),
      ),
    );
  } else {
    io.stdout(line(`project: ${project.name}`));
    io.stdout(line(`id: ${project.id}`));
    io.stdout(line(`index: ${state}`));
    if (error) io.stdout(line(`error: ${error}`));
  }
  if (options.wait && state === 'error') {
    io.stderr(line(`indexing failed: ${error}`));
    return EXIT.runFailed;
  }
  return EXIT.ok;
}

export interface TokenCreateOptions {
  project: string;
  name?: string;
  expiresInDays?: number;
  allowedCidrs: string[];
}

/** `token create`: another MCP token for a project (`POST /api/projects/:id/mcp-tokens`). */
export async function tokenCreate(ctx: CommandContext, options: TokenCreateOptions): Promise<number> {
  const project = await resolveProject(ctx.client, options.project);
  const minted = await ctx.client.request<McpTokenResponse>('POST', `/api/projects/${project.id}/mcp-tokens`, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
    ...(options.allowedCidrs.length > 0 ? { allowedCidrs: options.allowedCidrs } : {}),
  });
  if (ctx.json) {
    ctx.io.stdout(
      line(JSON.stringify({ project: { id: project.id, name: project.name, mcpUrl: project.mcpUrl }, token: minted.token, secret: minted.secret })),
    );
  } else {
    ctx.io.stdout(line(`project: ${project.name}`));
    ctx.io.stdout(line(`mcp-url: ${project.mcpUrl}`));
    ctx.io.stdout(line(`mcp-token-secret: ${minted.secret}`));
  }
  return EXIT.ok;
}
