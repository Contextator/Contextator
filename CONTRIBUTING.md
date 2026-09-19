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

which talks to the endpoint as a real MCP client would.

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

## The pairs that are kept in sync

Three places in this repository hold one statement in two files. Each has a check that fails when the two
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
copyright holder. That second half only works while the copyright is held in full: a contribution merged
without a licence grant permanently removes the ability to grant a commercial licence over that code, and
reverting the commit afterwards does not undo it.

So **before an outside contribution is merged, its author is asked to grant a licence.** The text is
[`CLA.md`](CLA.md) — a copyright licence and a patent grant to the copyright holder, in both an individual
and an entity version.

### How you sign

Asking is not a maintainer remembering to; it is [`.github/workflows/cla.yml`](.github/workflows/cla.yml),
which runs [CLA Assistant Lite](https://github.com/contributor-assistant/github-action) on every pull
request. You do not sign anything before opening one, and there is no form to fill in anywhere else.

1. **Open the pull request.** A check named **Licence grant** runs. If every commit author in it has
   already signed, it is green and you are done — nothing is posted and there is nothing to read.
2. **If somebody has not**, the workflow leaves a comment on the pull request naming them and linking
   [`CLA.md`](CLA.md). The check is red, and a red one cannot be merged.
3. **Read `CLA.md`, then post this as a pull request comment**, on one line and nothing else in it:

   ```
   I have read the CLA Document and I hereby sign the CLA
   ```

   The comment *is* the signature — the workflow reads it, records it, and re-runs the pull request's own
   check, which then goes green. It takes a minute or so. Capitalisation does not matter and a full stop
   at the end is fine; a sentence buried in a longer, multi-line comment is not read. **If nothing
   happens within a couple of minutes, comment `recheck`** — that is the recovery path for a signature
   the workflow did not pick up, and for a check left stale by anything else.
4. **Every commit author signs**, not just whoever opened the pull request. If your branch carries a
   commit written by a colleague, they comment too, from their own account, and the account has to be the
   one the commit's e-mail belongs to. Bots are exempt; they cannot agree to anything. There is no
   allowlist — maintainers sign this like everybody else.

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

### What is in force, and what merely stops a merge

`CLA.md` is in force. It stopped calling itself a draft in the same change that gave the workflow a
signatures repository and a token to reach it, because the two have to move together: a signature
collected under a document still saying "do not treat anything in this document as an agreement you have
entered into" would have been worth nothing, and the window between them is closed by ordering rather
than by hoping it is short.

What is not yet in place is **branch protection** — the setting that makes a red **Licence grant** a
refusal rather than a warning. Until it is, the check still runs and still names anybody who has not
signed, but a maintainer could merge past it. That is a gap in enforcement and not in the grant: signing
is what binds you, and protection is only what stops the merge. It is the next thing to switch on, and
this paragraph goes when it does.

If that is not something you are willing to grant, say so early. Opening an issue that describes the
problem and lets a maintainer implement it is a perfectly good contribution and needs none of this.
