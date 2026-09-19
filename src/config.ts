import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';

/** Project names double as URL segments (`/mcp/:projectName`), so keep them URL-safe. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const flag = (value: string): boolean => value === '1' || value.toLowerCase() === 'true';

/**
 * The three subnet names `proxy-addr` — the library behind Fastify's `trustProxy` — understands, and
 * the only entries in `TRUST_PROXY` that are not a literal address. `loopback` is the one a
 * single-container deployment with a proxy on the host actually wants.
 */
const TRUST_PROXY_SUBNETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** `10.0.0.0/8`, `fd00::/8`, `192.0.2.7`, or one of the names above. Nothing else is an entry. */
function isTrustProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_SUBNETS.has(entry)) return true;
  const slash = entry.lastIndexOf('/');
  if (slash === -1) return net.isIP(entry) !== 0;
  const family = net.isIP(entry.slice(0, slash));
  if (family === 0) return false;
  const prefix = entry.slice(slash + 1);
  // A prefix *length*, not a netmask: `proxy-addr` accepts `10.0.0.0/255.0.0.0` too, and this
  // deliberately does not — two spellings of one subnet is a second thing to get wrong.
  if (!/^\d{1,3}$/.test(prefix)) return false;
  // `/0` is refused at both ends of the same argument. It is `1` spelled as a subnet — every address
  // matches it — and `proxy-addr` throws `TypeError: invalid range on address` on it while Fastify is
  // being constructed, which would end the process on a bare stack trace instead of the message below.
  return Number(prefix) >= 1 && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Turns `TRUST_PROXY` into the value Fastify takes, or `undefined` when it is not a value we accept
 * ([ADR-0060](../.ssot/ADR.md#adr-0060)).
 *
 * **Three forms, and the fourth is refused on purpose.** `0`/`false` trusts nothing, `1`/`true` trusts
 * every proxy, and a comma-separated list of addresses, CIDR blocks and subnet names trusts exactly
 * those peers. Fastify also accepts a **hop count**, and this does not: a number is a claim about how
 * many proxies are in front of the instance that the server cannot check, and it goes silently wrong
 * the day somebody puts a CDN in front of the reverse proxy — which is the class of failure this whole
 * variable exists to end.
 *
 * **What a list actually does, because it is not what it looks like.** `proxy-addr` walks
 * `[socket address, ...X-Forwarded-For reversed]` from the socket outwards and stops at the first
 * address the list does **not** trust; `req.ip` is that address. So the list is applied to *every hop*,
 * not only to the peer — which is what makes it strong when the trusted range holds nothing but
 * proxies, and worthless when clients live in it too. `TRUST_PROXY=uniquelocal` on a LAN is the
 * example worth remembering: a client at `192.168.1.77` is inside the range, so it is walked past, and
 * `X-Forwarded-For: 203.0.113.99` puts that value straight into `req.ip`. Name the proxy, not the
 * network the callers are on.
 *
 * Refusing the hop count is also what keeps `1` unambiguous: it is `true` here, as it is for every
 * other flag in this file, and not "one hop".
 */
function parseTrustProxy(value: string): boolean | string[] | undefined {
  // Lowercased once, for the whole value rather than for the booleans only: `Loopback` and `FD00::/8`
  // are the same entries as their lowercase spellings, and an operator who writes one and is refused
  // learns nothing from the refusal. Addresses are case-insensitive, so nothing is lost by folding.
  const lowered = value.trim().toLowerCase();
  if (lowered === '0' || lowered === 'false') return false;
  if (lowered === '1' || lowered === 'true') return true;
  const entries = csv(lowered);
  if (entries.length === 0) return undefined;
  return entries.every(isTrustProxyEntry) ? entries : undefined;
}

/**
 * Held back from `CHUNK_MAX_TOKENS` when it is checked against the model's window (ADR-0035).
 *
 * Both of the things it was originally sized for are now counted rather than guessed at (ADR-0036): the
 * chunker subtracts each section's own heading breadcrumb, and `CHUNK_TOKENIZER_RESERVE_TOKENS` below
 * covers the tokenizer's special tokens. What is left for this margin to absorb is the tiny-chunk merge,
 * which can append a stub to a chunk that was already at budget, and the fact that a subword tokenizer
 * is not additive — `count(a) + count(b)` and `count(a + b)` differ by a token either way.
 */
export const CHUNK_BUDGET_RESERVE_TOKENS = 16;

/**
 * What the chunker itself sets aside, per chunk, on top of the breadcrumb it counts (ADR-0036): the
 * `<s>`/`</s>` the tokenizer wraps every input in, which `EmbeddingProvider.countTokens` deliberately
 * does not report.
 *
 * It is not the whole reserve any more. The provider's `passage: ` prefix is part of the string the model
 * reads too (ADR-0038), and it is counted with the model's own tokenizer rather than written down here,
 * because an operator can change it. `chunkReserveTokens` in `services/chunk-budget.ts` is the sum, and
 * is what the indexer and the eval harness both hand the chunker.
 */
export const CHUNK_TOKENIZER_RESERVE_TOKENS = 2;

/** `CHUNK_MAX_TOKENS`' own floor, so a suggested budget is never a value the schema would refuse. */
export const CHUNK_MAX_TOKENS_MIN = 50;

/**
 * The most excerpts one search may be asked for — the ceiling on `limit` in both callers.
 *
 * It used to be called `MAX_SEARCH_CANDIDATES` and it used to be both things at once. Since
 * [ADR-0041](../../.ssot/ADR.md#adr-0041) a search collects `DENSE_CANDIDATES` from one side and
 * `LEXICAL_CANDIDATES` from the other, fuses them and *then* takes `limit`, so the count the index is
 * asked for and the count a caller receives are different numbers and no longer share a name.
 */
export const MAX_SEARCH_LIMIT = 20;

/**
 * How many chunks each half of retrieval contributes before the two are fused
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). Fifty, the same on both sides, and one number rather
 * than two: the cross-encoder rerank of ROADMAP Item 2's last bullet would rerank *the fused top
 * fifty*, and a pool that is fifty from one side and thirty from the other is a pool nobody can
 * describe in a sentence.
 *
 * They live here rather than beside `searchChunks` only because the `superRefine` at the bottom of
 * this file has to check `HNSW_EF_SEARCH` against `DENSE_CANDIDATES`, and `services/vector-store.ts`
 * reaches `config.ts` for its `Config` type. Importing a value back the other way would be a cycle.
 */
export const DENSE_CANDIDATES = 50;
export const LEXICAL_CANDIDATES = 50;

/**
 * When a query term stops being worth matching on
 * ([ADR-0041](../../.ssot/ADR.md#adr-0041)): a lexeme present in more than a tenth of a project's
 * chunks is dropped from the lexical query.
 *
 * **This is the whole difference between a lexical half that helps and one that hurts, and it was
 * measured rather than reasoned about.** PostgreSQL's `ts_rank_cd` scores term frequency and
 * proximity and has no notion of inverse document frequency, so `What does HLY-4019 mean?` asked as a
 * plain OR of its lexemes ranks a paragraph that happens to contain *what*, *does* and *mean* above
 * the reference table that contains `HLY-4019` — three covered terms against two. Fused, that
 * paragraph then arrives with a rank on both lists and displaces the answer. Measured on the golden
 * set, unfiltered: `recall@5` 79.7 % against dense-only's 82.8 %, and twelve questions dense-only
 * answered at rank 1 pushed down or off the page. The filter is what turns that around.
 *
 * **A twentieth is the middle of a plateau and not a tuned number.** Swept at eight values from 0.015
 * to 0.08, `recall@5` measures 85.9 % everywhere except 0.03 and 0.08, where it measures 87.5 % — one
 * question, at two points that are not adjacent, which is noise and not a peak. Every value in that
 * range beats dense-only. What matters is that *what*, *does* and *mean* are out and `HLY-4019` is in,
 * not where exactly the line is drawn.
 */
export const LEXICAL_TERM_MAX_DOCUMENT_FREQUENCY = 0.05;

/**
 * The floor under that fraction, so a project of forty chunks does not drop every term it has. A term
 * in ten of forty chunks is still a term worth matching when there is nothing rarer to match on.
 */
export const LEXICAL_TERM_MIN_DOCUMENT_FLOOR = 10;

/**
 * `read_document`'s token budget ([ADR-0043](../../.ssot/ADR.md#adr-0043)), in tokens counted by the
 * embedding provider's own tokenizer rather than in bytes pretending to be tokens.
 *
 * 4 000 is a deliberate answer to the 512 KB cap it replaces: a 100 KB Markdown file is around 25 000
 * tokens, spent in one tool call by an agent that asked for a file and had no way to ask for less. The
 * ceiling is 20 000, so an agent that genuinely wants a whole manual can still say so — it just has to
 * say so.
 *
 * Constants and not settings: they are the *tool's* contract, they are stated in the prompt-visible
 * description an agent reads, and an instance where `read_document` means something different from
 * every other instance is a tool an agent cannot be told about once.
 */
export const READ_DOCUMENT_DEFAULT_MAX_TOKENS = 4_000;
export const READ_DOCUMENT_MAX_MAX_TOKENS = 20_000;

/** Below this a budget cannot hold a chunk and its header, so the tool would answer nothing at all. */
export const READ_DOCUMENT_MIN_MAX_TOKENS = 200;

/** Documents per `list_topics` page, and the ceiling on what one call may ask for (ADR-0043). */
export const LIST_TOPICS_DEFAULT_LIMIT = 200;
export const LIST_TOPICS_MAX_LIMIT = 1_000;

/**
 * The band a per-source sync interval may be set to ([ADR-0048](../.ssot/ADR.md#adr-0048)), in
 * minutes. Constants rather than settings, for `read_document`'s reason: they are the *API's*
 * contract, stated in `API.md` and enforced by the route's schema on every instance.
 *
 * Five minutes at the bottom because below it the probe stops being cheap relative to the thing it is
 * protecting — twelve `git ls-remote`s an hour per repository is a number a git host will notice —
 * and because a source that genuinely needs to be fresher than five minutes wants the push webhook it
 * already has. Thirty days at the top so that "off" stays expressible only as NULL, and a very long
 * interval cannot be mistaken for one.
 */
export const SYNC_MIN_INTERVAL_MINUTES = 5;
export const SYNC_MAX_INTERVAL_MINUTES = 30 * 24 * 60;

/**
 * How long a Notion webhook verification window stays open
 * ([ADR-0049](../.ssot/ADR.md#adr-0049)), in minutes.
 *
 * **A constant and not a setting**, for the reason the band above is one: it is the API's contract and
 * it is what [OPERATIONS.md](../.ssot/OPERATIONS.md) §5.19 tells an operator to expect, and an instance
 * where this means something different is an instance whose runbook no longer describes it.
 *
 * Fifteen minutes covers the operator's real path — switch to Notion, find the connection, paste the
 * URL, create the subscription, come back — plus one **Resend token** if the first delivery went
 * missing, while staying far shorter than the interval over which somebody who learned the URL could
 * plausibly be waiting to post a token of their own.
 */
export const WEBHOOK_VERIFICATION_WINDOW_MINUTES = 15;

/**
 * How long an expired OAuth credential is kept before the sweep deletes it
 * ([ADR-0054](../.ssot/ADR.md#adr-0054)), and how long an unused registered client is.
 *
 * Constants and not settings, because neither is a number an operator has a reason to hold an opinion
 * about. The grace exists for one reason: `search_queries.mcp_token_id` points at these rows
 * ([ADR-0047](../.ssot/ADR.md#adr-0047)), so deleting one the instant it expires would take the
 * attribution of every search that session made. A week is longer than any access token's life and far
 * shorter than the query log's own thirty-day retention, so the log's rows outlive their tokens by
 * design and lose their `askers` count rather than their content.
 *
 * Thirty days for a client, because a connector that registered and never came back is a row nobody
 * will ever recognise — and one that *did* come back is exempt by the sweep's own predicate, which
 * keeps any client still holding a live credential whatever its age.
 */
export const OAUTH_CREDENTIAL_SWEEP_GRACE_MS = 7 * 24 * 60 * 60_000;
export const OAUTH_CLIENT_STALE_MS = 30 * 24 * 60 * 60_000;

/**
 * The short window: a client that registered and **never came back**, dropped after a day.
 *
 * It is separate from the thirty days above because the two describe different things. A connector
 * somebody actually used and then left alone is theirs and deserves the long rope; a row written by an
 * unauthenticated `POST` that never reached the consent page is one nobody will ever recognise, and it
 * is the only kind a flood can produce. Holding those for a month would turn `MCP_OAUTH_MAX_CLIENTS`
 * into a month-long lockout of every honest connector — which is what a ceiling with no floor under it
 * does, and is a denial of service rather than a defence against one.
 */
export const OAUTH_CLIENT_UNUSED_MS = 24 * 60 * 60_000;

/**
 * How many clients one host may register, and over how long
 * ([ADR-0054](../.ssot/ADR.md#adr-0054)). The same `SlidingWindow` the sign-in route uses, and for the
 * same reason: `MCP_OAUTH_MAX_CLIENTS` bounds the *table*, and nothing bounded the **rate** at which a
 * single host could walk it to its ceiling.
 *
 * **Sixty an hour, and the number is about NAT rather than about connectors.** One connector registers
 * once per instance it connects to, so ten looked generous — until the thirty people behind one office
 * address set theirs up on the morning the operator announced it, and the eleventh was answered `429`
 * for an hour with nothing in the message to tell them why. A "host" here is an address, not a person,
 * and the common deployment puts a department behind one.
 *
 * It is deliberately **not** the thing that bounds abuse. `req.ip` is only as trustworthy as
 * `TRUST_PROXY` makes it ([ADR-0060](../.ssot/ADR.md#adr-0060)): at `1` it is the left-most
 * `X-Forwarded-For` and a script can write it, and even named to the proxy it is one address for a
 * whole office. What bounds abuse is `OAUTH_CLIENT_UNUSED_MS` — a row that never connects is gone
 * within a day, whatever address claimed it — and this is what keeps ordinary traffic and ordinary
 * mistakes from reaching the ceiling at all.
 */
export const OAUTH_REGISTER_MAX_PER_HOST = 60;
export const OAUTH_REGISTER_WINDOW_MS = 60 * 60_000;

/** Exported for the tests: the cross-field rules are the only part of this file that has behaviour. */
export const EnvSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3444),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PUBLIC_BASE_URL: z.url().optional(),
    /**
     * Which peers may tell this server where a request came from
     * ([ADR-0060](../.ssot/ADR.md#adr-0060)).
     *
     * `req.ip` is the key of both sliding windows in this product — the sign-in budget and
     * `/oauth/register`'s per-host budget — and of the address stored beside an audit event. With this
     * on, `req.ip` is the left-most `X-Forwarded-For` value; with it off, it is the socket's own peer
     * address, which no header can change.
     *
     * **`0` is the default, and it is the default because of the shape this product ships in.**
     * `docker-compose.yml` publishes 3444 with nothing in front of it, and there `1` would have bought
     * nothing at all while letting any caller write its own rate-limit key — a limiter that looks like
     * it is working and is not. The cost of `0` is real and lands the other way: **behind a reverse
     * proxy, left unset, every request appears to come from the proxy**, so the per-IP sign-in budget
     * becomes an instance-wide one and ten failures can shut the sign-in page for everybody. That is a
     * misconfiguration an operator can see happening and fix with this one variable; a forged `req.ip`
     * is one nobody can see at all. So: **put a proxy in front of this and you must set this.**
     *
     * **It is not only the rate limits.** `req.protocol` follows the same setting, and three places
     * build a base URL from it when `PUBLIC_BASE_URL` is unset — the OAuth protected-resource metadata,
     * the `WWW-Authenticate` pointer on a `401` from `/mcp/*`, and the admin API's own URLs. Off behind
     * a TLS-terminating proxy, those read `http://`, the client sends `https://`, and
     * `projectNameFromResource` refuses the mismatch: every connector is answered `invalid_target`.
     * `AUTH_COOKIE_SECURE=auto` loses its `Secure` flag for the same reason. **Set `PUBLIC_BASE_URL`
     * as well as this**, and the two URL-shaped failures stop depending on the header at all.
     *
     * Set it to the proxy rather than to `1` wherever you can — and to the **proxy**, not to the
     * network the callers sit on: the list is applied to every hop, so a range that holds clients as
     * well as proxies is walked past and the caller writes `req.ip` again. `1` is "trust whoever wrote
     * the header", which is only safe when nothing but the proxy can open a socket to this port.
     */
    TRUST_PROXY: z
      .string()
      .default('0')
      .transform((value, ctx) => {
        const parsed = parseTrustProxy(value);
        if (parsed === undefined) {
          ctx.addIssue({
            code: 'custom',
            message:
              'must be 0/false, 1/true, or a comma-separated list of IP addresses, CIDR blocks and the subnet names ' +
              `${[...TRUST_PROXY_SUBNETS].join('/')} (for example "loopback" or "10.0.0.0/8,172.18.0.0/16"); ` +
              'a hop count is deliberately not accepted — name the proxy instead',
          });
          return z.NEVER;
        }
        return parsed;
      }),
    /** Machine access to /api/*, acting with root permissions. People sign in with an account. */
    ADMIN_TOKEN: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().default('').transform(csv),
    /** MCP transport sessions, not dashboard sign-ins — those are AUTH_SESSION_IDLE_MS. */
    SESSION_IDLE_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(30 * 60_000),

    // Authentication (dashboard accounts). See src/auth/.
    /** A dashboard session that goes unused for this long has to sign in again. */
    AUTH_SESSION_IDLE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(12 * 60 * 60_000),
    /** Hard ceiling on a session's life, however actively it is used. */
    AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** `auto` sets Secure when the request arrived over HTTPS; force it behind a proxy. */
    AUTH_COOKIE_SECURE: z.enum(['auto', '1', '0']).default('auto'),
    AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(10),
    AUTH_LOGIN_WINDOW_MIN: z.coerce.number().int().min(1).max(1440).default(15),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(12),
    /** Pins the first-run setup code instead of generating one. Ignored once an account exists. */
    SETUP_CODE: z.string().min(8).max(128).optional(),

    // MCP OAuth 2.1 (ADR-0054). What these switch on is a *second* way to present a credential at
    // /mcp/*, never a second set of rights: what an OAuth session reaches is the membership of the
    // account that approved it, checked on every request.
    /**
     * Whether this instance is an OAuth authorization server for its own MCP endpoints.
     *
     * **On by default, because off is the state the feature exists to end**: a browser-based MCP
     * connector has no way to send a configured header, so with this off such a client cannot connect
     * to this product at all — which is the defect, not a safe default. What turning it on actually
     * exposes is three metadata documents that disclose nothing an operator has not already published
     * (RFC 9728 and RFC 8414 are designed to be public), a consent page that redirects an anonymous
     * visitor to `/login`, a token endpoint that answers only a code somebody signed in to get, and
     * one unauthenticated write: a dynamic client registration, capped by `MCP_OAUTH_MAX_CLIENTS` and
     * swept when unused.
     *
     * `0` unregisters every one of those routes rather than making them answer 404, so an instance
     * that wants only static tokens has no OAuth surface at all.
     */
    MCP_OAUTH: z.string().default('1').transform(flag),
    /**
     * How long an issued access token lives, in minutes.
     *
     * An hour is the usual OAuth answer and it is short for a reason that is specific to this product:
     * every request re-reads the account and its membership, so a removed membership takes effect on
     * the next call rather than at expiry — the TTL is what bounds a *stolen* token, and the membership
     * check is what bounds a revoked person. The refresh token is what keeps an hour from being an
     * hourly interruption.
     */
    MCP_OAUTH_ACCESS_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(60),
    /**
     * How long a refresh token lives, in days, counted from the moment it was issued — and it is
     * reissued on every use, so an actively used connection is never older than one rotation.
     *
     * Thirty days matches `AUTH_SESSION_TTL_DAYS`' default on purpose: a browser connector's grant is
     * the same person's continued access by another door, and the two going stale at different times
     * would be a difference nobody could explain.
     */
    MCP_OAUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * The ceiling on rows in `oauth_clients`. It is a cap on an **unauthenticated write**, not on
     * access: registering a client grants nothing at all, so this defends the table rather than the
     * documents. Two hundred is far more connectors than an instance has and far fewer than a script
     * can write in a second.
     */
    MCP_OAUTH_MAX_CLIENTS: z.coerce.number().int().min(1).max(100_000).default(200),

    // Database: a connection string, or (when unset) the libpq PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
    // variables that node-postgres reads itself. The Docker image uses the latter for its embedded PostgreSQL.
    DATABASE_URL: z.string().min(1).optional(),
    RESET_VECTORS: z.string().default('0').transform(flag),

    // Documents
    ALLOWED_DOC_ROOTS: z.string().default('/docs').transform(csv),
    IGNORE_GLOBS: z.string().default('').transform(csv),
    /** Writable directory for materialised sources (git checkouts, uploads, Notion pulls). */
    DATA_DIR: z
      .string()
      .default('.data')
      .transform((p) => path.resolve(p)),
    /** Encrypts source secrets (git / Notion tokens) at rest. Only needed once such a source exists. */
    SECRET_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
    /**
     * How much of a document's text is kept in `documents.content`, in bytes of UTF-8
     * ([ADR-0043](../../.ssot/ADR.md#adr-0043)). Past it the prefix is stored and
     * `documents.content_truncated` is set, so `read_document` can say what it is not showing.
     *
     * A megabyte of Markdown is a document nobody wrote by hand, and the row is TOAST-compressed out
     * of line, so the steady-state cost is a fraction of the vectors the same document produces — see
     * [OPERATIONS.md](../../.ssot/OPERATIONS.md) §7. It is a setting rather than a constant because
     * the one installation that needs it lowered is the one with a generated corpus, and it would
     * otherwise have to fork the product to get it.
     */
    MAX_STORED_DOCUMENT_BYTES: z.coerce
      .number()
      .int()
      .min(4096)
      .default(1024 * 1024),

    /**
     * What one file of a **converted** type — `.html`, `.csv`, `.docx`, `.pdf` — may weigh before the
     * indexer will parse it ([ADR-0056](../../.ssot/ADR.md#adr-0056)). `.md`, `.mdx` and `.txt` are
     * decoded rather than parsed and are not capped.
     *
     * **It is deliberately lower than `UPLOAD_MAX_FILE_BYTES`, because it answers a different
     * question.** The upload limit is about what may be *stored*, and it never applied to a local
     * directory or a git checkout at all. This one is about what may be *parsed*, in the server's own
     * process, beside the dashboard and `/mcp` — so it has to hold for every source type. A file over
     * it is refused by name with the reason on its source; the run carries on.
     *
     * 32 MiB is a very large document and a small fraction of a container's memory. Raise it if your
     * corpus genuinely holds bigger ones and the host has the headroom.
     */
    MAX_CONVERTED_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .default(32 * 1024 * 1024),

    /**
     * What one API specification may weigh before the indexer will parse it
     * ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
     *
     * **Its own ceiling, and much lower than `MAX_CONVERTED_FILE_BYTES`, because it bounds a different
     * cost.** A converted type's output is roughly the size of its input. A specification is parsed
     * whole into a JS object graph, and that graph measures **about fifty-five times the file** — 1 MiB
     * of YAML became 60 MiB of objects, 2 MiB became 113 MiB, 4 MiB became 218 MiB, 8 MiB became
     * 444 MiB. At the 32 MiB conversion ceiling that is well over a gigabyte in the process that also
     * serves the dashboard and `/mcp`, which is not a ceiling at all.
     *
     * **And the graph is not transient.** The indexer renders one document at a time out of it, so it
     * stays live for as long as that one file is being indexed — beside the embedding model, which on
     * the default provider is another ~470 MB. Measured directly: an 8 MiB specification completes
     * under `--max-old-space-size=384` and is OOM-killed under 320, so **a file at the ceiling wants
     * roughly 400 MB of heap headroom while it is indexed**, and the requirement scales with the file.
     *
     * 8 MiB is kept as the default because it admits every specification anyone has published —
     * Stripe's is about 6 MB, Kubernetes' about 4 — and refusing those out of the box would be a worse
     * default than a documented memory cost. An instance whose container is tight should **lower** it:
     * a file over it is refused by name with the reason on its source and the run carries on, which is
     * a far better failure than the OOM kill it prevents.
     */
    MAX_SPEC_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(16 * 1024)
      .default(8 * 1024 * 1024),

    /**
     * Pages a PDF may declare before it is refused unread (ADR-0056).
     *
     * The page count is a number written in the file, and `extractTextItems` reads every page into one
     * array — so a few kilobytes of PDF claiming a hundred thousand pages is not bounded by
     * `MAX_CONVERTED_FILE_BYTES` in any way. 2 000 pages is a reference manual; past that it is either
     * a generated artefact or a file written to be indexed.
     */
    MAX_PDF_PAGES: z.coerce.number().int().min(1).default(2000),

    /**
     * What a `.docx`'s own central directory may claim its parts unpack to (ADR-0056).
     *
     * A `.docx` is a zip, mammoth hands it to `jszip`, and `jszip` has no size ceiling of its own — so
     * a zip bomb, a megabyte that inflates to a terabyte, would inflate into this process's heap.
     *
     * **The size in the archive's directory is not trusted, because whoever built the archive wrote
     * it** — `jszip` reads the same field and only compares it against reality *after* inflating the
     * part, by which time the memory is gone. Each part is inflated through a counter and discarded,
     * with this as the ceiling. Bounding `compressedSize × worst case` instead would be sound and
     * useless: DEFLATE reaches about 1030:1, so it would refuse an ordinary one-megabyte Word file on
     * the grounds that it *could* have been a gigabyte.
     */
    MAX_DOCX_UNPACKED_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .default(256 * 1024 * 1024),

    // Uploads and archives
    UPLOAD_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(50 * 1024 * 1024),
    UPLOAD_MAX_FILES_PER_REQUEST: z.coerce.number().int().min(1).max(5000).default(500),
    UPLOAD_MAX_ARCHIVE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(256 * 1024 * 1024),
    ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).default(20_000),
    ARCHIVE_MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(1024 * 1024 * 1024),

    // Embeddings
    EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
    /**
     * `multilingual-e5-small` is trained for retrieval rather than for paraphrase similarity, reads 512
     * tokens where the previous default read 128, and is 384-dimensional — so the swap needs no
     * `EMBEDDING_DIMENSIONS` change, no re-typed column and no `RESET_VECTORS` (ADR-0037). It does change
     * the provider id, and every project indexed with the old one re-indexes itself on its next run.
     */
    EMBEDDING_MODEL: z.string().default('Xenova/multilingual-e5-small'),
    // 2000 is the pgvector HNSW limit for the `vector` type
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(2000).default(384),
    EMBEDDING_DTYPE: z.enum(['fp32', 'fp16', 'q8']).default('fp32'),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(16),
    MODEL_CACHE_DIR: z.string().default('.cache/models'),
    EMBEDDING_OFFLINE: z.string().default('0').transform(flag),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    /**
     * What the model reads usefully — the window it was trained at, not where the tokenizer cuts.
     * Deliberately optional and deliberately without a default: the window is a runtime fact the local
     * provider discovers from the loaded tokenizer, and a number guessed here from `process.env` would
     * be wrong for exactly the operator running a model this product has never heard of (ADR-0035).
     * Setting it both overrules what the provider discovers and makes the check below fire at startup.
     */
    EMBEDDING_MAX_INPUT_TOKENS: z.coerce.number().int().min(64).max(32_000).optional(),
    /**
     * Overrides the instruction prefixes the provider's table picks for the configured model (ADR-0038).
     * Unset, the table decides — `query: ` / `passage: ` for the `multilingual-e5-*` family, nothing for
     * everything else.
     *
     * `loadConfig` drops empty-string values below, so an empty assignment means "unset" and cannot say
     * "no prefix" on a model the table knows. `none` is how that is said; `resolvePrefixes` maps it to the
     * empty string. Either value changes `provider.id` and therefore forces a re-index.
     */
    EMBEDDING_QUERY_PREFIX: z.string().optional(),
    EMBEDDING_PASSAGE_PREFIX: z.string().optional(),

    // Chunking (counted with the embedding model's own tokenizer — ADR-0036)
    /**
     * 96, and it is a measurement rather than a derivation. The default model reads 512 tokens, so the
     * budget check would allow 496 — and 496 measures worse than 96 on the golden set, because a long
     * passage's mean-pooled vector is an average of more things and there are fewer chunks to hit
     * (ADR-0037). 88, 96, 104 and 108 all measure identically; 96 is the interior of that plateau rather
     * than its edge, which is at 112. An operator on OpenAI's 8191-token window should still raise it.
     */
    CHUNK_MAX_TOKENS: z.coerce.number().int().min(CHUNK_MAX_TOKENS_MIN).max(4000).default(96),
    /** A quarter of the budget, because what has to survive a chunk boundary is a sentence, and a sentence does not get shorter when the budget does. */
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(24),

    // Search: how far into the HNSW index one query is allowed to look (ADR-0040). All three are set
    // per search transaction with `set_config(..., is_local => true)`, never on the connection — the
    // pool hands the same connection to unrelated work a moment later.
    /**
     * Candidates the index yields before the project and generation predicates are applied. pgvector's
     * own default is 40, which is the *whole* answer to a top-k on a busy instance: the predicates are
     * a post-filter, so 40 candidates drawn from every project's chunks can leave a small project with
     * a handful of hits or none. 100 is the usual small-corpus recall setting and the number this
     * product runs at; it is a knob because the trade is latency against recall and the right point
     * depends on how many projects share the index.
     */
    HNSW_EF_SEARCH: z.coerce.number().int().min(1).max(1000).default(100),
    /**
     * pgvector 0.8's iterative scan: when the post-filter leaves fewer than `limit` rows, keep scanning
     * instead of answering short. `relaxed_order` re-searches with a growing `ef_search` and is what
     * makes a 50-chunk project answerable inside a 20 000-chunk instance; `strict_order` keeps rows in
     * distance order at a higher cost; `off` is pgvector's default and this product's old behaviour.
     *
     * Under `relaxed_order` the rows do not arrive in distance order — `searchChunks` re-sorts them.
     */
    HNSW_ITERATIVE_SCAN: z.enum(['off', 'relaxed_order', 'strict_order']).default('relaxed_order'),
    /**
     * The stop condition that actually fires once iterative scan is on: how many index tuples one query
     * may visit before it gives up and answers with what it has. pgvector's default is 20 000, and it is
     * nameable here because the number that matters is *the instance's* row count, not a project's — a
     * project holding 1 % of the chunks has to be scanned past to be found.
     */
    HNSW_MAX_SCAN_TUPLES: z.coerce.number().int().min(1).default(20_000),

    // Search: how the fused list is turned into an answer (ADR-0042). None of the four changes what
    // retrieval finds; they change which of it an agent is handed, and every default is the value the
    // golden set was measured at.
    /**
     * How many excerpts of one document may appear in one answer. Two, because five results that are
     * five consecutive chunks of the same page answer one question five times — and because a cap is a
     * rule an operator can state in a sentence, where MMR is a λ nobody has a budget to tune.
     *
     * Applied after fusion and refilled from the candidates below it, so a capped answer is still the
     * requested number of excerpts. Measured on the golden set: `recall@5` 85.9 % → 87.5 % and
     * `heading@5` 82.8 % → 84.4 %, because the excerpt a cap displaces is a near-duplicate of one
     * already on the page. Set it to `SEARCH_LIMIT`'s ceiling to turn the cap off.
     */
    SEARCH_MAX_PER_DOCUMENT: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(2),
    /**
     * Chunks either side of a hit, rendered as context around it rather than as extra results. One is
     * enough to carry the sentence a chunk boundary cut in half; `0` turns it off.
     *
     * It is not free. A chunk is `CHUNK_MAX_TOKENS` — 96 by default since ADR-0037, where it used to be
     * 512 — so a hit plus two neighbours is roughly three times the context it used to be, which is
     * what `SEARCH_MAX_RESULT_CHARS` below is for.
     */
    SEARCH_NEIGHBOR_CONTEXT: z.coerce.number().int().min(0).max(3).default(1),
    /**
     * The ceiling on one rendered `search_docs` answer, in characters, after which it is cut with an
     * explicit `[…truncated]`. Measured: a default answer — five excerpts, one neighbour a side —
     * renders at around 3 300 characters on the evaluation corpus, so this is the budget of an agent
     * that asked for twenty and not of one that asked for five.
     */
    SEARCH_MAX_RESULT_CHARS: z.coerce.number().int().min(500).default(12_000),
    /**
     * The cosine similarity below which `search_docs` answers "no good match" instead of handing over
     * its best hit ([ADR-0042](../.ssot/ADR.md#adr-0042)). `0` turns the gate off.
     *
     * **It is a number about one embedding model, and the default is measured against the default
     * model.** Under `multilingual-e5-small` every question the golden set answers has a top hit at
     * 0.833 or above, and a question about something the corpus has never heard of tops out at 0.829;
     * 0.82 sits below the first with margin and still catches ten of twelve such questions. Under
     * another model the same number means something else entirely — `text-embedding-3-small` scores the
     * same pair of texts far lower — so changing `EMBEDDING_MODEL` and leaving this alone is a way to
     * refuse every search. The server says so at startup rather than leaving it to be discovered.
     *
     * What it does **not** separate is a question shaped like this product whose answer is simply not
     * written down: those score inside the band of questions the corpus does answer, and no threshold
     * splits them. That is ROADMAP.md Item 6's query log, not this.
     */
    SEARCH_SCORE_FLOOR: z.coerce.number().min(0).max(1).default(0.82),

    /**
     * The cross-encoder rerank of ROADMAP.md Item 12, between the fusion and the truncation, over the
     * fused candidate pool. **`off` is the default and `off` is what the product ships.**
     *
     * Off by default is not timidity, it is what keeps the gated `eval` job measuring the
     * configuration an operator actually runs: a spike that was on by default would quietly become the
     * thing the floors were set against, and the floors would then be defending an experiment. It also
     * costs a second model — another few hundred megabytes resident and a forward pass per candidate —
     * on the CPU the single indexing queue is already competing for, against NFR-02's sub-second budget.
     *
     * Turning it on changes the query path as well as the ranking: the fused set has to come back to
     * Node to be scored, so one round trip becomes two. `searchChunks` says what that costs.
     */
    SEARCH_RERANK: z.enum(['off', 'on']).default('off'),
    /**
     * Which cross-encoder, when it is on. `Xenova/bge-reranker-base` because it is the only
     * transformers.js-shaped multilingual reranker that loads with no artefact work of ours — the
     * cheaper `mmarco-mMiniLMv2-L12-H384-v1` has no `Xenova/` build, does not use the file names the
     * dtype selection reads, and was not trained on Turkish.
     */
    SEARCH_RERANK_MODEL: z.string().default('Xenova/bge-reranker-base'),
    /** `q8` is 279 MB against fp32's 1 112 MB, and this is a rerank rather than a retrieval score. */
    SEARCH_RERANK_DTYPE: z.enum(['fp32', 'fp16', 'q8']).default('q8'),
    /**
     * Where a (question, passage) pair is cut. 128 is not a saving: a chunk is `CHUNK_MAX_TOKENS`, 96
     * by default, so a pair is a question plus ninety-six tokens and a longer window would pad.
     */
    SEARCH_RERANK_MAX_TOKENS: z.coerce.number().int().min(32).max(512).default(128),
    /** Pairs per forward pass. The pool is at most a hundred, so this is about peak memory. */
    SEARCH_RERANK_BATCH: z.coerce.number().int().min(1).max(100).default(16),

    // The query log (ADR-0047): what agents asked, and what they got. Two switches, and the per-project
    // one is deliberately not here — it is `projects.query_log_enabled`, so that it travels with a
    // `pg_dump` and with a project export instead of reverting to the new host's environment.
    /**
     * The instance-wide kill switch. `0` and nothing is recorded anywhere, whatever any project's own
     * column says — the server simply does not build a sink, so `SearchDeps.queryLog` is unset and the
     * search path has nothing to write to.
     *
     * On by default, for the reason the per-project column is: the log answers "agents asked about X 41
     * times this week and the best match scored 0.31", and that answer needs weeks of rows behind it.
     * A switch an operator has to find and turn on collects nothing during exactly the period the first
     * report would be drawn from. What makes that defensible rather than presumptuous is the retention
     * below, the per-project column, and a privacy page that says so in §2, §4 and §7.
     */
    SEARCH_QUERY_LOG: z.string().default('1').transform(flag),
    /**
     * How long a recorded query is kept. Swept on the interval the session reaper already runs on, so
     * there is no third timer in the process.
     *
     * Thirty days is a month of traffic — enough for "this week against last week", which is the
     * comparison the report is made of — and it is short enough that the log is not a permanent record
     * of everything anybody ever asked. **It is a policy decision an operator has to make**, not a
     * tuning knob: the rows are user content, they are in every `pg_dump`
     * ([ADR-0046](../.ssot/ADR.md#adr-0046)), and this number is what the instance's own privacy page
     * is promising on their behalf.
     */
    SEARCH_QUERY_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

    // The audit log and /metrics (ADR-0055). Both are about the instance rather than about any one
    // project, which is why neither has a per-project column beside it the way the query log does.
    /**
     * How long an audit event is kept, in days. Swept on the same quarter-hourly timer as expired
     * sessions and the query log, for the reason there is no third timer in this process.
     *
     * **A year, where the query log keeps thirty days, and the difference is the point.**
     * `search_queries` holds what people typed — user content, in every `pg_dump`, under a window
     * short enough that it is not a permanent record of everything anybody ever asked. `audit_events`
     * holds what an operator did to the instance: no question, no document, no excerpt, a few dozen
     * rows a month. The reason to forget the first quickly does not apply to the second, and the
     * question an audit log is opened for — "who deleted that source, and when" — is routinely asked
     * about something that happened last quarter.
     */
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    /**
     * A bearer credential that reaches `/metrics` and **nothing else**.
     *
     * It exists so that scraping does not mean handing Prometheus an `ADMIN_TOKEN`, which acts with
     * root permissions over every project: a scrape credential should be able to do exactly the one
     * thing a scrape does. Unset by default, in which case `/metrics` still answers a signed-in
     * account or `ADMIN_TOKEN` — what is never true by default is that it answers nobody in particular.
     */
    METRICS_TOKEN: z.string().min(16).optional(),
    /**
     * `1` answers `/metrics` with no credential at all.
     *
     * Off by default, and that is the decision rather than the default: the exposition names this
     * instance's version, its embedding model, how many projects are queued and how deep its database
     * pool is, which is a description of the machine to anyone who can reach the port. The case this
     * exists for is real though — a container on a private network, or an instance behind a proxy that
     * already decides who may reach `/metrics` — and in that deployment a second credential is
     * ceremony over a door somebody else is already guarding. So it is expressible, and it has to be
     * written down.
     */
    METRICS_PUBLIC: z.string().default('0').transform(flag),

    // Scheduled sync (ADR-0048). The per-source interval is a column and not a setting, for the reason
    // the query log's per-project switch is one: it travels with a `pg_dump`. These two are the
    // instance's policy about sources it has not met yet, and about how hard one tick may push.
    /**
     * The interval a **newly created** source is given, in minutes. `0` creates every new source with
     * scheduling off, which is how an instance opts out of the whole feature.
     *
     * It does not reach a source that already exists — not on upgrade, and not when this value
     * changes. [ADR-0048](../.ssot/ADR.md#adr-0048)'s migration leaves every existing source at NULL
     * so that an upgrade cannot start making outbound calls nobody asked for (NFR-10), and a setting
     * that retroactively switched them on would be the same mistake taken one release later.
     *
     * An hour, because the two things this exists for are a mounted folder somebody edits and a Notion
     * workspace somebody writes in, and neither is worth a minute of latency on a `git ls-remote`
     * against every repository on the instance. The probe is cheap; it is not free.
     */
    SYNC_DEFAULT_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(SYNC_MAX_INTERVAL_MINUTES).default(60),
    /**
     * How many due sources one scheduler tick may probe. The rest keep their turn — they are still
     * due, they are ordered oldest-first, and the next tick a minute later takes the next ten.
     *
     * Ten a minute is six hundred an hour, which is more sources than an instance with a one-hour
     * default interval can have due in an hour. It is a ceiling on the *burst* a synchronised herd
     * could produce, not a throughput budget, and the jitter in `next_sync_at` is what makes the herd
     * unlikely in the first place.
     */
    SYNC_PROBES_PER_TICK: z.coerce.number().int().min(1).max(1000).default(10),
    /**
     * The minimum number of minutes between two **webhook-triggered** runs of one source
     * ([ADR-0049](../.ssot/ADR.md#adr-0049)), when the source itself does not name one.
     *
     * A delivery that arrives to a source whose last sync is older than this queues a run at once, in
     * the interactive lane; one that arrives sooner writes the earliest permitted moment and lets the
     * scheduler's tick take it, so two hundred deliveries from a bulk edit collapse into one run.
     *
     * Five minutes, because a Notion run is a pull of somebody else's API and the deliveries that make
     * this matter arrive in bursts rather than steadily. `0` means no minimum at all — every delivery
     * queues immediately, which is only sane on a small workspace and is the reason it is expressible.
     *
     * Unlike `SYNC_DEFAULT_INTERVAL_MINUTES` this is read **live**: a source's own
     * `webhook_min_interval_minutes` being NULL means "whatever the instance currently says", because a
     * debounce is a limit the instance imposes rather than a schedule somebody chose per source.
     */
    WEBHOOK_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(SYNC_MAX_INTERVAL_MINUTES).default(5),
  })
  .superRefine((c, ctx) => {
    if (c.EMBEDDING_PROVIDER === 'openai' && !c.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required when EMBEDDING_PROVIDER=openai' });
    }
    if (c.CHUNK_OVERLAP_TOKENS >= c.CHUNK_MAX_TOKENS) {
      ctx.addIssue({ code: 'custom', path: ['CHUNK_OVERLAP_TOKENS'], message: 'must be smaller than CHUNK_MAX_TOKENS' });
    }
    // Only when the operator has stated the window. Unset, this rule says nothing at all — the runtime
    // half in src/services/chunk-budget.ts is what checks a window that had to be discovered, and it
    // warns rather than exiting. Stated and contradicted is the one case that is a refusal (ADR-0035).
    if (c.EMBEDDING_MAX_INPUT_TOKENS !== undefined && c.CHUNK_MAX_TOKENS + CHUNK_BUDGET_RESERVE_TOKENS > c.EMBEDDING_MAX_INPUT_TOKENS) {
      const suggested = Math.max(CHUNK_MAX_TOKENS_MIN, c.EMBEDDING_MAX_INPUT_TOKENS - CHUNK_BUDGET_RESERVE_TOKENS);
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_MAX_TOKENS'],
        message:
          `plus ${CHUNK_BUDGET_RESERVE_TOKENS} reserved tokens does not fit in EMBEDDING_MAX_INPUT_TOKENS=${c.EMBEDDING_MAX_INPUT_TOKENS}; ` +
          `set it to ${suggested} or lower, or raise the window if the model really reads that much`,
      });
    }
    // An HNSW scan cannot return more rows than it collected candidates, so an `ef_search` below the
    // number of dense candidates one search asks for is short by construction — before the project and
    // generation predicates have discarded anything at all (ADR-0040). ADR-0041 raised that number from
    // 20 to 50, and this rule was already written against the constant so that it would move with it.
    // It is the floor, not the setting: at `ef_search = DENSE_CANDIDATES` a search of a shared instance
    // still starves, and the default is 100 for that reason.
    if (c.HNSW_EF_SEARCH < DENSE_CANDIDATES) {
      ctx.addIssue({
        code: 'custom',
        path: ['HNSW_EF_SEARCH'],
        message:
          `must be at least ${DENSE_CANDIDATES}, the number of dense candidates one search asks for before fusion; ` +
          'below it the index cannot yield a full candidate list even before the project predicate filters one row',
      });
    }
    // `0` is "create new sources with scheduling off"; anything else has to be a value the API would
    // also accept, or the dashboard could not display — let alone save — a source the server minted.
    if (c.SYNC_DEFAULT_INTERVAL_MINUTES !== 0 && c.SYNC_DEFAULT_INTERVAL_MINUTES < SYNC_MIN_INTERVAL_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['SYNC_DEFAULT_INTERVAL_MINUTES'],
        message: `must be 0 (new sources are not scheduled) or at least ${SYNC_MIN_INTERVAL_MINUTES}, the floor the API enforces on a per-source interval`,
      });
    }
    if (c.ALLOWED_DOC_ROOTS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_DOC_ROOTS'], message: 'at least one directory is required' });
    }
    if (c.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60_000 < c.AUTH_SESSION_IDLE_MS) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_SESSION_TTL_DAYS'], message: 'must not be shorter than AUTH_SESSION_IDLE_MS' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parses and validates process.env. Empty-string values are treated as unset so that
 * `.env.example` placeholders such as `ADMIN_TOKEN=` behave like missing keys.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    console.error('Invalid configuration:\n' + z.prettifyError(result.error));
    process.exit(1);
  }
  if (!result.data.DATABASE_URL && !raw.PGHOST && !raw.PGDATABASE) {
    console.error('Invalid configuration:\n✖ Set DATABASE_URL, or the libpq variables PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
    process.exit(1);
  }
  return result.data;
}
