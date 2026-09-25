# Contributing to Contextator

Thank you for looking. This file is the short version of how the project is worked on: how to get it
running, what a change has to pass, and the two rules that are not obvious from the code — that a change
to observable behaviour is written in the specification first, and that an outside contribution needs a
licence grant before it can be merged.

Read [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) too. Security problems do not go in an issue — see
[`SECURITY.md`](SECURITY.md).

---

## Running it

You need Node.js 22 or newer — what the image runs and what CI has always used — and a container runtime for the database.

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 16 + pgvector on localhost:5432, nothing else
cp .env.example .env
npm install
npm run dev                                      # tsx watch, http://localhost:3444
```

`.env.example` is annotated and every setting has a default that works on a laptop. Three are worth
knowing before the first start:

- **`SETUP_CODE`** decides the one-time code `/setup` asks for when you create the first account. Pick one
  and you never have to read it out of a log; leave it empty and the server prints a generated one at
  every start until that account exists.
- **`ALLOWED_DOC_ROOTS`** is the containment boundary for local document sources. A project directory
  outside it is refused. The repository's own `docs/demo` is inside the default.
- **`SECRET_KEY`** (32+ characters, `openssl rand -hex 32`) is only needed once a source stores a token —
  a private git repository or Notion.

**The first start downloads the embedding model** — about 470 MB for the default multilingual one, into
`.cache/models`. It loads in the background, so the dashboard is usable immediately, but the first search
waits for it. `EMBEDDING_DTYPE=q8` cuts the download to ~120 MB if you only need it to work.

Once it is up: create the first account at `/setup`, then a project pointing at `docs/demo`, then

```bash
npm run smoke -- http://localhost:3444/mcp/demo "how do I re-index"
```

which talks to the endpoint as a real MCP client would. Add `--sse` to the same command to exercise the
legacy SSE transport instead of Streamable HTTP.

`npm run db:studio` opens Drizzle Studio against `DATABASE_URL`, for looking at the tables directly.

## The checks a change has to pass

These four are the gate. CI runs exactly them (plus `npm run db:check` and a build of the image) on every
pull request, so running them before you push is most of staying green.

```bash
npm run lint             # biome: format and lint over src, test, scripts and public
npm run typecheck        # both tsconfigs — the build's, and the one that covers test/ and scripts/
npm test                 # the unit suite: no database, no Docker, a few seconds
npm run test:integration # the same runner against a real PostgreSQL + pgvector
```

`npm run lint:fix` writes every fix Biome can make. The configuration is [`biome.jsonc`](biome.jsonc) and
each non-obvious setting has the reason next to it — please read the comment before turning a rule off.

**`npm test` needs no Docker.** That is deliberate and worth keeping: the inner loop stays fast, so it
stays run.

**Three of its tests need the embedding model**, and skip with a note until you have it: the tokenizer
counted against Turkish text, and the two sides of one sentence encoded through the prefixes of
ADR-0038. If you have already started the server once you have the model; otherwise

```bash
npm run warm-model       # ~490 MB into .cache/models, once, then never again
```

downloads it through the server's own warm-up path and checks that the files those tests look for are
where they look. CI does not skip them — the `check` job caches the same directory and populates it on a
miss, and an absent cache fails the job rather than quietly reporting three fewer assertions than the
suite claims.

**`npm run test:integration` does need a container runtime.** It starts `pgvector/pgvector:pg16` itself
through testcontainers, gives every test file its own database and throws the container away afterwards —
`docker-compose.dev.yml` is not involved and nothing has to be started by hand. The first run pulls a
460 MB image and is a minute or two slower than every run after it.

Docker Desktop and a stock Linux install need no configuration. A socket somewhere else does:

```bash
# Colima
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock

# Rancher Desktop
export DOCKER_HOST="unix://$HOME/.rd/docker.sock"

# rootless Podman
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED=true
```

`npm run test:all` runs both suites. And tell `git blame` to step over the one commit that only
reformatted the tree:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Project layout

```
src/server.ts                 Fastify entrypoint / composition root
src/config.ts                 zod-validated environment
src/db/schema.ts              Drizzle schema — the source `drizzle/*.sql` is generated from, and the only description of the tables
src/db/bootstrap.ts           startup: the extension, the migration journal, `migrate()`, the vector dimension, and reconciling the per-project HNSW indexes
src/db/vector-indexes.ts      one partial HNSW index per project: its name, its concurrent build and drop, the queue that serialises them, and the bootstrap's reconcile
src/services/chunker.ts       Markdown/MDX-aware chunking with heading breadcrumbs; pure and synchronous, the token counter injected
src/services/fs-scan.ts       safe directory walking + path-escape checks
src/services/sources.ts       source CRUD and the zod schema of each type's config
src/services/sources/         one driver per type: local, git (isomorphic-git), upload, notion, confluence
src/services/sources/confluence.ts        the Confluence driver, Cloud and Data Center: the page tree, the incremental skip, and the probe
src/services/sources/confluence-client.ts the REST surface it talks to, as an interface plus an HTTPS implementation, and the one place CQL is built
src/services/sources/confluence-egress.ts where a Confluence request may connect: the address check after DNS and on every redirect, CONFLUENCE_ALLOWED_HOSTS
src/services/sources/confluence-render.ts storage format → the plain XHTML `doc-types/html.ts` converts; it does not convert HTML itself
src/services/sources/web.ts               the documentation-site driver: the three entry formats, the five ceilings, and the sitemap probe
src/services/sources/web-client.ts        its one HTTP surface — serial, paced, inside a deadline — as an interface plus an implementation
src/services/sources/web-entry.ts         sitemap, llms.txt, robots.txt, links and URL→path, as pure functions over strings
src/services/flavors.ts       content-type transforms (Obsidian wikilinks, Notion export ids) and which of them expand one file into many
src/services/openapi.ts       OpenAPI/Swagger → one Markdown document per operation: $ref resolution, cycle and depth guards, derived paths
src/services/doc-types/       one transform per file extension, all of them producing Markdown: html, docx, csv, pdf
src/services/doc-types/pdf.ts a PDF read as a layout — lines, columns, running heads, headings by size, tables by alignment
src/services/conversion/      the thread all of that runs on: `worker.ts` (the same transforms, over there), `client.ts` (a thread that dies, one that stops answering, a refusal that has to arrive as a refusal), `protocol.ts` (the wire)
scripts/build-doc-fixtures.ts the dependency-free PDF and zip writers the binary test fixtures come from
src/types/                    ambient declarations for the two dependencies that ship none (mammoth, the turndown GFM plugin)
src/services/archives.ts      zip / tar / tar.gz / rar extraction with path and size guards
src/services/uploads.ts       staged upload sessions and their commit into a source
src/services/data-dir.ts      layout of DATA_DIR, atomic directory swaps, orphan sweep
src/services/crypto.ts        AES-256-GCM encryption of source tokens and webhook secrets, and the key id that makes SECRET_KEY rotatable
src/services/encrypted-fields.ts  the one list of columns encrypted under SECRET_KEY, derived from the schema so a new one cannot be forgotten
src/services/embeddings/      provider interface, local (transformers.js) and OpenAI implementations
src/services/chunk-budget.ts  the after-warmup half of the chunk budget check: what the model reads, against what the chunker produces
src/services/indexer.ts       incremental background indexing queue
src/services/vector-store.ts  the fused search statement (vector + keyword) and chunk persistence
src/services/rrf.ts           reciprocal rank fusion: the arithmetic that turns two rankings into one
src/services/text-search.ts   which PostgreSQL text search configuration the keyword half speaks
src/services/search.ts        the one search path: the guards, the query embedding and the top-k query, shared by the MCP tool and the search API
src/mcp/router.ts             /mcp/:project — Streamable HTTP + legacy SSE on one URL
src/mcp/tools.ts              search_docs, list_topics, read_document
src/services/document-read.ts  joining chunks back into a section, and cutting text to a token budget
src/mcp/sessions.ts           per-connection McpServer/transport registry + idle reaper
src/auth/policy.ts            every authorization rule as data — no DB, no Fastify, fully unit-tested; also which requests are audit events and what they may record
src/auth/authorize.ts         the request checks that need no database, in the order they must happen
src/auth/plugin.ts            resolves the principal (cookie, ADMIN_TOKEN or an account's own API token) and applies the policy
src/services/auth/api-tokens.ts  mint/list/verify/revoke for an account's own scoped API tokens (ctxk_…)
src/auth/cookies.ts           the session cookie's name, flags and Secure decision
src/auth/csrf.ts              same-site check for cookie-authenticated writes
src/services/passwords.ts     scrypt hashing (node:crypto), policy and temporary passwords
src/services/auth/            accounts, sessions, memberships and the first-run setup gate
src/services/rate-limit.ts    in-memory sliding window for sign-in attempts
src/services/audit.ts         the audit log: the row an action becomes, the writer the policy layer holds, and the retention sweep
src/services/metrics.ts       the process counters and the Prometheus text /metrics answers with
src/admin/routes.ts           REST API for the dashboard
src/services/scheduler.ts     the sync schedule: which sources are due, the cheap per-driver check, and the run it queues
src/admin/sources-routes.ts   source CRUD, sync, test, webhook secret
src/admin/upload-routes.ts    multipart upload sessions (the only multipart-parsing plugin)
src/admin/webhooks.ts         push webhooks, verified with the per-source secret — git's and Confluence's generated here, Notion's captured from them
src/services/notion-webhook.ts which Notion deliveries mean a run, the window a captured token may be stored in, and the debounce before the queue
src/admin/auth-routes.ts      /api/auth/* and /api/setup/*
src/admin/users-routes.ts     /api/users/*
src/admin/tokens-routes.ts    /api/tokens/* — an account's own API tokens, self-service
src/admin/audit-routes.ts     /api/audit — the read side of the audit log: the filters, the keyset page, and the sentence a row is rendered as
src/admin/members-routes.ts   /api/projects/:id/members/*
src/admin/mcp-routes.ts       /api/projects/:id/mcp-tokens/* and the open/token/account switch
src/mcp/access.ts             the MCP endpoint's access rule, as a pure function
src/mcp/identity.ts           turns the Authorization header into an account and its membership, for that rule to judge
src/mcp/oauth-routes.ts       the OAuth 2.1 flow for /mcp/*: discovery, registration, the approval page, the token endpoint
src/services/auth/oauth.ts    registered OAuth clients, the authorization codes, and the PKCE check
src/admin/pages.ts            /about, /privacy, /cookies, /terms, /license rendered into one shell
src/admin/auth-pages.ts       /login, /setup, /change-password and the guard on `/`
public/                       vanilla HTML/JS dashboard (no build step)
public/core.js                shared helpers: el(), api(), state, the event bus
public/auth.js                the signed-in account, the top-bar menu, permission helpers
public/users.js               the account list at #/~users
public/tokens.js              your own API tokens at #/~tokens — create, list, revoke
public/audit.js               the audit log at #/~audit — who changed this instance, filtered and paged by the server
public/queries.js             a project's query-log panel: what agents asked, the export beside it, and the project's own relevance floor with its preview
public/members.js             a project's Members panel
public/mcp.js                 a project's MCP access panel and its tokens
public/search.js              a project's search box and the hits it renders, scores and all
public/auth-page.js           /login, /setup and /change-password — imports nothing from the dashboard
public/product-facts.json     generated: the numbers and identifiers this product can be quoted on, for the site in the other repository to check its prose against
public/pages/                 body of each product/legal page + the shell they share, and the OAuth approval page
scripts/smoke-mcp.ts          end-to-end MCP client check
scripts/reset-password.ts     last-resort password reset straight against the database; ships in the image and runs there
scripts/rotate-secret.ts      `npm run rotate-secret` — moves every encrypted value onto the current SECRET_KEY; re-runnable, interruptible, and silent about plaintext
scripts/backup.ts             `npm run backup` — the database, the upload trees and a manifest in one archive; never SECRET_KEY, only its fingerprint
scripts/restore.ts            `npm run restore` — the same archive back, with every refusal decided before a byte is unpacked (`--check` decides them and writes nothing)
scripts/backup-archive.ts     the archive's format and every refusal in it: the manifest, the key check value, the topology, and where pg_dump/pg_restore run
scripts/embedded-database.ts  how an operator command run through `docker exec` finds the container's own PostgreSQL — the entrypoint's PG* variables are not in that environment
scripts/build-product-facts.ts `npm run build:facts` — writes public/product-facts.json by reading the declarations, never by restating them
scripts/eval.ts               `npm run eval` — indexes eval/corpus, asks eval/golden.jsonl, prints recall@1, recall@5, MRR
scripts/eval-scoring.ts       the scoring arithmetic and the report, with no database or model in it, so it can be unit-tested
scripts/cla/rules.ts          the licence gate's judgements — who authored a pull request, who may sign, what the record says — with no I/O in them
scripts/cla/github.ts         the two GitHub surfaces it is handed: this repository, and the signatures repository behind its own narrow token
scripts/cla/run.ts            the gate wired up: read the event, record a signature, judge, ask once, re-run the pull request's check
scripts/cla/main.ts           what the workflow runs — the environment, the two tokens and the exit code, and no decision at all
test/*.test.ts                unit suite — pure functions, no database, no Docker (`npm test`)
test/cla-*.test.ts            the licence gate: its judgements, the whole flow against fakes, and the GitHub clients against an injected fetch
test/dockerhub-description.test.ts  DOCKERHUB.md fits Docker Hub's limit, its links are absolute, and it names the image
test/container-topology.test.ts     the packaging contract: `full` is still the default target, `slim` still carries no database, and neither compose file has gone back to forcing DATABASE_URL empty
test/backup-manifest.test.ts        the backup's refusals, each in both directions: the key check value, the server's major version, the topology, the manifest reader
test/product-facts.test.ts    public/product-facts.json is still what the generator produces from today's code
test/integration/*.itest.ts   the bootstrap, the schema equivalence review, vector-store, the password reset and /api/health against a real PostgreSQL + pgvector
test/integration/support/     the testcontainers harness, and the schema projection two schemas are compared with
test/integration/fixtures/    a pre-v3 `0.1` schema derived from history, and the frozen DDL ladder the migrations replaced
test/fixtures/doc-types/      one real file per supported type, plus the malformed ones a refusal has to survive
test/support/confluence-stub.ts a `ConfluenceClient` answering out of an array, shared by the unit and the integration suite so one page tree drives both
test/support/web-stub.ts      a `WebClient` answering out of a map of URL → response, recording every request so a ceiling can be asserted by what was *not* fetched
test/fixtures/web/            a sitemap, a sitemap index, an `llms.txt` and a `robots.txt`, each carrying the awkward case the parser has to survive
eval/corpus/                  the fixture corpus the golden set asks about: 15 English and 11 Turkish pages, written for this
eval/golden.jsonl             48 questions, one JSON object per line, each naming the file that answers it
eval/README.md                what a good question is, how to add one, and why the failures are kept
eval/BASELINE.md              the last recorded run of the default configuration
drizzle/                      generated migrations (`npm run db:generate`), applied at startup and shipped in the image
CHANGELOG.md                  what shipped in each release, Keep a Changelog style, for the operator pulling the image — not the commit log
CONTRIBUTING.md               how to run it, the four checks, the pairs kept in sync, and the licence grant
CLA.md                        the contributor licence grant, in force; signed on a pull request
SECURITY.md                   how to report a vulnerability, and what is documented behaviour rather than one
CODE_OF_CONDUCT.md            Contributor Covenant 2.1
LICENSE                       AGPL-3.0-or-later, verbatim; copied into the image and served at /license.txt
docs/demo/                    sample documentation (English, Turkish, MDX)
Dockerfile                    two images over one build: `full` (postgres:16 + pgvector + Node 22 + the app, the default target) and `slim` (the app alone)
docker/entrypoint.sh          starts PostgreSQL unless DATABASE_URL names one, then the app; stops both in order on SIGTERM
docker-compose.yml            the `contextator` container and its volumes; embedded PostgreSQL, or an external one when .env names it
docker-compose.build.yml      overlay for docker-compose.yml that builds the image from source instead of pulling it
docker-compose.slim.yml       the `-slim` image against a PostgreSQL you operate — a whole file rather than an overlay, because the pgdata mount has to be absent
docker-compose.dev.yml        PostgreSQL only, for `npm run dev`
charts/contextator/           Helm chart for Kubernetes: one Pod, the `-slim` image, an external PostgreSQL; `replicas: 1` is hardcoded, not a value; values checked by a strict values.schema.json
DOCKERHUB.md                  what Docker Hub shows on the repository page; not this README, which is well past its 25,000-character limit
biome.jsonc                   the one formatter and linter, and why each rule is set as it is
tsconfig.test.json            typechecks test/ and scripts/, which the build's tsconfig cannot see
.github/workflows/ci.yml      the gate on every pull request: lint, typecheck, tests, image build
.github/workflows/cla.yml     the licence grant: the `Licence grant` required check, and the lock on a merged thread
.github/workflows/release.yml on a `v*` tag: verify the image, then build and push it to Docker Hub for both architectures; then publish a changed Helm chart to the gh-pages repository
.github/workflows/helm-chart.yml lints and renders charts/contextator on every change to it, and asserts the decisions it encodes: one replica, the required values, the strict schema, probes, the data mount, a bumped chart version
.github/workflows/dockerhub-description.yml pushes DOCKERHUB.md to Docker Hub's description whenever it changes
.github/PULL_REQUEST_TEMPLATE.md   the FR/ADR reference, the checks, and the documented claims a change touches
.github/ISSUE_TEMPLATE/       bug report, feature request, and the links the issue chooser offers first
.git-blame-ignore-revs        commits that only reformatted; `git blame` should look through them
```

### How the single container works

`docker/entrypoint.sh` (under `tini`) launches the unchanged upstream `postgres` image entrypoint in the
background, so first-run `initdb`, `POSTGRES_*` handling and `/docker-entrypoint-initdb.d` work exactly
as in the official image. Once `pg_isready` succeeds on `127.0.0.1:5432` it starts `node dist/server.js`
as the unprivileged `node` user with the libpq `PG*` variables pointing at that server. `SIGTERM` stops
the app first and then PostgreSQL (fast shutdown); if either process dies the other is stopped and the
container exits so `restart: unless-stopped` can bring the pair back.

`DATABASE_URL` is what makes that paragraph conditional. Set, the entrypoint skips all of it: no
postmaster is started, the `PG*` variables are deliberately left unset so the URL is the only answer
to *where is the database*, and the container supervises one process instead of two. The startup log
names which of the two it chose — with the credentials cut out of the connection string — and
`/api/health` says the same thing as `database.mode` to a signed-in caller, with the host, port and
database name beside it for an administrator. The `-slim` image is this path with the PostgreSQL
removed from the image as well: it sets `CONTEXTATOR_EMBEDDED_POSTGRES=0`, and started without a
`DATABASE_URL` it exits immediately naming the variable rather than searching for a database that
was never built into it.

### How the schema evolves

There is one way to change the schema and it has four steps: edit `src/db/schema.ts`, run
`npm run db:generate`, read the SQL drizzle-kit wrote into `drizzle/`, and commit both. Nothing else
creates or alters a table, and `npm run db:check` — a step in CI — fails if the schema and the
migrations stop agreeing.

Nothing is asked of the operator. `src/db/bootstrap.ts` runs `migrate()` at startup, under a
session-scoped advisory lock, with `drizzle/*.sql` baked into the image: upgrading is
`docker compose pull && docker compose up -d` and there is still no migration command to forget. An installation that
predates the migrations is adopted on its first start — its schema is already the baseline, so a row
is written to drizzle's journal saying so and nothing is applied.

Two things stay out of the generated SQL because they cannot be in it. The vector column's dimension
is a deployment setting (`vector(384)` vs `vector(1536)`), so `schema.ts` carries a constant 384 for
the migration to bake in and the bootstrap re-types the column to the configured dimension
afterwards, once, before any row exists — drizzle-kit diffs `schema.ts` against its own snapshot and
never against the live database, so a deployment at 1536 cannot be seen by it, let alone broken by it.
The HNSW indexes are the second: one partial index per project, named after the project, which a
generated migration could never describe; each needs a fixed dimension and blocks the re-typing while
it exists, so the bootstrap creates them after. The dimension is still recorded in `settings` and a mismatch still
fails fast with the remedy in the message.

What used to rest on review has a test: `test/integration/schema-equivalence.itest.ts` applies the
frozen DDL ladder to one database and the new bootstrap to another and compares the two schemas as
text, on every pull request, against a real server.

## Specification first

A change to **observable behaviour** — an endpoint, a response shape, a default, a rule about who may do
what, anything a user could notice — references the requirement it satisfies (`FR-…`) or the decision it
implements (`ADR-…`). If neither exists, it is written down before it is built, not explained afterwards
in a commit message.

That writing happens in a separate specification repository which holds the PRD, the architecture
decision records, the data model, the API contract, the security model and the roadmap. It is where the
`FR-…` and `ADR-…` identifiers in this codebase's comments point.

**It is not public.** An outside contributor cannot read it and cannot write to it, and there is no point
pretending otherwise: a rule you are unable to follow is worse than no rule. So the rule for you is the
part you can do.

- **Describe the behaviour change in the pull request itself.** What it does, what it replaces, what it
  makes impossible, and what you considered and rejected. That last part is the one that is expensive to
  rediscover, and it is what the records in that repository are mostly made of.
- **A maintainer records it** and replies with the `FR-…` or `ADR-…` your change now carries, before the
  merge. If your change contradicts something already decided, that is a conversation and not a rejection
  — several of the decisions in this project supersede an earlier one.
- **A change with no observable behaviour** — a refactor, a test, a typo, a dependency bump — needs none
  of this. Say so in the pull request and that is the end of it.

**Looking for the roadmap, not the process?** The roadmap mentioned above is internal to that private
repository. What has shipped, what is planned and what is being considered is tracked separately, in
public, on the [Contextator Roadmap](https://github.com/orgs/Contextator/projects/1) board.

## The pairs that are kept in sync

Four places in this repository hold one statement in two files. Each has a check that fails when the two
stop agreeing, because none of them is something a compiler or a formatter can see.

**`src/db/schema.ts` ↔ `drizzle/`**, guarded by `npm run db:check` (its own step in CI). The schema file
is the source the migrations are generated from, and adding a column is four steps and no others:

1. Edit `src/db/schema.ts`.
2. Run `npm run db:generate`.
3. **Read the SQL** drizzle-kit wrote into `drizzle/` — this step is the review, not a formality.
4. Commit both.

Nothing else creates or alters a table. Do not hand-write a migration, and do not edit a generated one
after the fact; the snapshot in `drizzle/meta/` is what the next generate diffs against. Two things stay
out of `schema.ts` on purpose — the vector column's dimension is a deployment setting, and the HNSW index
cannot exist before that dimension is settled — and both are handled by `src/db/bootstrap.ts` at startup.

**`public/index.html` ids ↔ the dashboard modules**, guarded by `test/dashboard-wiring.test.ts`. The
dashboard has no build step, so nothing links its JavaScript to its markup: a renamed id fails silently
in the browser, at the moment somebody clicks. That test is the missing link. Rename an id and it tells
you which module still looks for the old one.

**The policy table ↔ every `/api` route**, guarded by `test/auth-coverage.test.ts`. Authorisation is data
in `src/auth/policy.ts`, applied by one hook, and a route declares no permission of its own — a read is a
viewer's and any other method an editor's unless the table says otherwise. The test walks the server's own
route table and fails if a route is neither listed as public nor covered by a rule. **Adding a route
therefore means deciding who may call it**, and the suite will not let you forget.

**The code ↔ `public/product-facts.json`**, guarded by `test/product-facts.test.ts`. The marketing site
lives in a separate repository and states this product's numbers in prose — how many source types there
are, which extensions are indexed, what the score floor is, what a tool's parameters are called. That
prose used to be checked by somebody remembering; now the site checks itself against this file. It is
generated, never edited: run `npm run build:facts` and commit what it writes, the same way `drizzle/` is
committed. The generator reads each value out of the declaration that governs it — a zod default, an
`as const` tuple, the table's check constraint, the tool registration itself — so a value it cannot read
is deliberately *absent* from the facts and listed under `notMachineReadable` instead, with the reason.
Never hand-write one in; an unbacked number here is worse than no number, because the site would then
report it as verified.

**Which release the gate looks at:** the file committed here, at the version in its own `productVersion`
field — so cutting a release means regenerating it in that release's commit, and the site picks it up
from the released tag. A running instance also serves its own copy at `/product-facts.json`.

## Commits and pull requests

Subjects are imperative and sentence-shaped, and they say *why* rather than what the diff already shows.
From the history:

```
Stay up when PostgreSQL hangs up on a connection the pool was holding
Make CI run the recovery tool inside the image, not look for it
```

Not `fix(db): pool error handler` — there is no scope prefix and no conventional-commits grammar here.
The body is prose, wrapped at about 80 columns, and it is where the reasoning goes: what was wrong, what
the fix rests on, what it deliberately does not do. Several of the commits in this repository are longer
than the change they carry, and that is the intended ratio for anything subtle.

**No trailers.** A commit message ends with its last sentence. No `Co-Authored-By`, no
`Generated with …`, no tool or session attribution, no `Signed-off-by`. The same goes for pull request
descriptions.

A pull request should say which `FR-…` or `ADR-…` it implements (or that it changes no observable
behaviour), confirm the four checks pass locally, and name any documented claim it changes — the README,
`.env.example` and the configuration table go stale silently, and a change that makes one of them false
is not finished until it has fixed it. The template asks for exactly that.

## The licence grant

Contextator is [AGPL-3.0-or-later](LICENSE), and a commercial licence is offered alongside it by the
copyright holder. `ADR-0025` is why the licence looks like that: Contextator is a server, and the
obligations a copyleft licence carries are triggered by *distribution* — a hosted service distributes
nothing, so a fork under any licence whose copyleft stops at distribution, the GPL included, could be
modified, run behind a URL for other people, and sold, and its users would never see what changed. AGPL
closes that gap. Its section 13 is the operative clause: a **modified** version reachable over a network
owes its users the corresponding source; running the unmodified software internally, the common case,
triggers nothing. The commercial licence sits next to
that because the copyright is held by one person in full, which is what makes it possible to offer terms
the AGPL does not carry — never as a condition of the AGPL, only as an alternative to it.

That condition is also its weak point: a contribution merged without a licence
grant permanently removes the ability to grant a commercial licence over that code, and reverting the
commit afterwards does not undo it. This is the CLA's whole reason to exist — not distrust of
contributors, and not a claim on work that stays theirs (see below), but the one condition that keeps the
commercial option in `ADR-0025` open at all.

So **before an outside contribution is merged, its author is asked to grant a licence.** The text is
[`CLA.md`](CLA.md) — a copyright licence and a patent grant to the copyright holder, in both an individual
and an entity version.

### How you sign

Asking is not a maintainer remembering to; it is [`.github/workflows/cla.yml`](.github/workflows/cla.yml)
and the script in [`scripts/cla/`](scripts/cla) it runs on every pull request. You do not sign anything
before opening one, and there is no form to fill in anywhere else.

1. **Open the pull request.** A check named **Licence grant** runs. If you and every commit author in it
   have already signed, it is green and you are done — nothing is posted and there is nothing to read.
2. **If somebody has not**, the workflow leaves a comment on the pull request naming them and linking
   [`CLA.md`](CLA.md). The check is red, and a red one cannot be merged.
3. **Read `CLA.md`, then post this as a pull request comment**, on one line and nothing else in it:

   ```
   I have read the CLA Document and I hereby sign the CLA
   ```

   The comment *is* the signature — the workflow reads it, records it, and re-runs the pull request's own
   check, which then goes green. It takes a minute or so. Capitalisation does not matter and a full stop
   at the end is fine; **the sentence with anything else around it is not read** — not a quotation of
   it, not a question about it, not a second line under it. That is deliberate: otherwise somebody
   quoting the sentence back would have signed a licence grant without meaning to. **If nothing happens
   within a couple of minutes, comment `recheck`** — that is the recovery path for a signature the
   workflow did not pick up, and for a check left stale by anything else.
4. **Whoever opens the pull request always signs, and so does every commit author in it.** If your
   branch carries a commit written by a colleague, they comment too, from their own account. Bots are
   exempt; they cannot agree to anything. There is no allowlist — maintainers sign this like everybody
   else.

   The opener is asked in every case because **that is the only account GitHub authenticated here**. A
   commit's author is resolved from the e-mail address written into the commit, and an address of the
   form `<id>+<login>@users.noreply.github.com` can be composed from anybody's public profile — so a
   commit can carry a resolved account that had nothing to do with writing it. Asking each resolved
   commit author as well is worth doing and is not a guarantee; asking the person who opened the pull
   request is.
5. **A commit whose e-mail belongs to no GitHub account cannot be signed for at all**, by anybody. The
   check names it and stays red, because an address that names no account is a licence nobody can grant.
   Add the address to your account under Settings → Emails, or rewrite the commit with one that is
   already there, and push again.

You sign once. Every later pull request from the same account is green from the start. A merged pull
request's conversation is then locked, which is tidiness rather than evidence: the record of your
signature is the entry in the JSON file below, not the comment.

### What you are agreeing to, in one paragraph

That the work is yours to give; that the copyright holder may licence it under any terms, the commercial
ones included; and a patent grant limited to what your own contribution infringes. **You keep your
copyright** and every right to use your work elsewhere, and what you contribute stays under the AGPL for
everyone regardless. `CLA.md` is the text and this sentence is not it — read the file before you comment.

### Where the signature is kept

In `Contextator/cla-signatures`, a private repository this organisation owns, as a JSON file recording
your GitHub username, user id, the pull request and the time. It is deliberately not a hosted service's
database: the record is the only evidence the licence grant ever happened, and it is not rented from
anybody. Nothing about you is published, and nothing is collected beyond what your comment already showed.

### What binds you, and what stops the merge

`CLA.md` is in force. It stopped calling itself a draft in the same change that gave the workflow a
signatures repository and a token to reach it, because the two have to move together: a signature
collected under a document still saying "do not treat anything in this document as an agreement you have
entered into" would have been worth nothing, and the window between them is closed by ordering rather
than by hoping it is short.

**Licence grant** is now a required check on `main`, administrators included. A red one is a refusal and
not a warning: `main` takes no direct pushes and no merge past an unsigned commit, and getting round it
means deliberately turning the protection off rather than clicking merge anyway. The two halves stay
different things, though — signing is what binds you, and protection is only what stops the merge. A
contribution merged without a signature would still be a contribution nobody granted a licence to, which
is why the check exists rather than a note asking politely.

If that is not something you are willing to grant, say so early. Opening an issue that describes the
problem and lets a maintainer implement it is a perfectly good contribution and needs none of this.
