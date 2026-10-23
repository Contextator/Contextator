# Contributing a connector

A connector is a **source type**: the thing that brings documents from somewhere (a git host, a wiki, a
website) onto the server's disk, where the indexer takes over. This guide lists every place a new type
touches, in the order that makes the build break least while you work.

Connectors live **in the tree**. There is no plugin loader and no driver SDK to publish against
(ADR-0012 rejected one): a connector is a pull request to this repository, reviewed like any other change.

Before you start, read two small files completely — they are the contract:

- `src/services/sources/driver.ts` — the `SourceDriver` interface and `registerDriver`.
- `src/services/sources/web.ts` — the most recent driver added, and the shortest path from "nothing" to
  "indexed". It was added in commit `10fbe89`; `git show 10fbe89 --stat` is the list of files a type touches.

`test/connector-guide.test.ts` registers a throwaway `dummy` type through exactly these steps and fails when
a step stops being true. If you change one of the mechanisms below, that test is the first thing to tell you.

## What a driver does, and what it does not

The indexer does not know any source type. It asks the source's driver to `sync()` (bring the materialised
copy up to date), then scans `docRoot()` like it scans every other directory. So a driver's whole job is:

- **fetch** into the directory the server gives it (`sourceCurrentDir(...)` in `src/services/data-dir.ts`),
  as plain files whose extensions the indexer already reads (`docs/file-types.md`);
- **report** what it did in a `SyncResult` (`note`, and a `configPatch` for values it wants stored);
- optionally answer cheap questions: `test()` for the dashboard's Test button, `probe()` to let the
  scheduler skip a run that would find nothing, `documentMeta()` for the origin URL and modified time.

It does **not** chunk, embed, store or search anything, and it never talks to the database for documents.

## The steps

### 1. Name the type — `SOURCE_TYPES`

`src/services/sources.ts`, the `SOURCE_TYPES` tuple. `SourceType` is derived from it, so the compiler
now points at everything keyed by type. The admin API (`z.enum(SOURCE_TYPES)` in
`src/admin/sources-routes.ts`) and the project import (`src/services/transfer/import.ts`) read the same
tuple and need no edit.

Adding a name here is the *only* thing that makes the type creatable; `createSource` refuses anything not in
the tuple before it touches the database.

### 2. Describe its settings — `SourceConfigByType`

Same file. Write a zod schema for the type's `config` object and add it to `SourceConfigByType`; export the
inferred type beside the others. `parseSourceConfig` is the single door every writer goes through (create,
update, project import), so validation written here is validation everywhere.

Rules that have bitten before:

- Keep `syncProbeToken` in the schema if the driver has a `probe` (the others do).
- A secret never goes in `config`. It goes in the `secret` field of the create/update body (step 8).
- A URL a user types is untrusted input. If the driver opens connections, route them through an egress check
  and add an `*_ALLOWED_HOSTS` setting like the web, git and Confluence drivers have.
- If the type has per-type validation that needs I/O (the local type resolves its path), it goes in
  `validateConfig`.

### 3. Migration — usually none

`document_sources.type` is a plain `text` column with **no check constraint**, so a new type value needs no
migration. You need one only if the connector adds a column, a table or an index of its own. If it does:

1. edit `src/db/schema.ts`;
2. `npm run db:generate`;
3. **read the SQL** drizzle-kit wrote;
4. `npm run db:check`, then commit `drizzle/` with the change.

Never hand-write a migration and never edit an applied one (`CONTRIBUTING.md`, "The pairs that are kept in
sync"). Prefer keeping connector state in the source's `config` (the driver returns it as `configPatch`)
over a new table: the project export and import already carry `config`.

### 4. The driver

Add `src/services/sources/<type>.ts` with a class implementing `SourceDriver`, and register it at import
time:

```ts
registerDriver('example', (source, ctx) => new ExampleDriver(source, ctx));
```

`ctx` is the `DriverContext` (`db`, `log`, `config`). Read your settings with
`parseSourceConfig('example', source.config)`, not by casting `source.config`.

Then make sure the file is imported once at startup: `src/server.ts` has a block of side-effect imports
(`./services/sources/confluence.js`, `git.js`, `notion.js`, `web.js`). Add yours there. A driver that is
registered but never imported is the most common "it works in the test and not in the app": the admin
route asks `isDriverAvailable(type)` and answers `409 not available on this server yet`, which is how you
will notice.

The probe rules in `driver.ts` are not decoration; the three that matter:

- `null`, a throw, or no `probe` at all means *run it*. An optimisation must never stop a source syncing.
- A probe has to cost far less than the `sync()` it avoids.
- The token `sync()` stores (under `PROBE_TOKEN_KEY`, in `configPatch`) is produced by the same method the
  probe uses, so "equal" can be trusted.

If the driver is network-bound, take its HTTP surface as a constructor parameter (an interface plus an
implementation, as `web-client.ts` and `confluence-client.ts` do). That is what lets the unit test run the
driver against a stub without opening a socket — `test/web-driver.test.ts` is the model, and
`test/support/` holds the stub servers.

### 5. Instance limits — `src/config.ts` (only if you need them)

Ceilings that an operator should be able to tune (page counts, hosts, timeouts) are environment variables,
and the environment is read **only** in `src/config.ts`. A new variable also goes in:

- `.env.example`,
- `docs/configuration.md`,
- the Helm chart (`charts/contextator/values.yaml`, `charts/contextator/values.schema.json`, `charts/contextator/templates/deployment.yaml`),
- `DriverContext.config` in `driver.ts`, as an optional key, so a context built for another driver need not
  carry it.

### 6. Project export and import — `src/services/transfer/manifest.ts`

The manifest has its own `z.enum([...])` of source types (a duplicate of `SOURCE_TYPES`; it has to be, a
manifest is a frozen file format). Add the new name there, and decide what the source `needs` on the other
side (`SOURCE_NEEDS`: a credential, a webhook secret, files carried in the archive, a path on this host, or
"never scheduled"). A build that does not know the type refuses the import outright rather than half-import
it, which is why this line cannot be left for later.

### 7. Admin API

Nothing to add for create, list, update and delete: they take the type from `SOURCE_TYPES`. Two hooks are
yours to use:

- `test()` on the driver is what `POST /api/projects/:id/sources/:sid/test` calls; return a short
  human-readable sentence, and throw to say it failed.
- Webhooks are separate. `HAS_WEBHOOK`, `DEBOUNCED_WEBHOOK` and `GENERATED_WEBHOOK_SECRET` in `sources.ts`
  decide which types sign deliveries; a connector without a push webhook leaves them alone.

If you add a route of your own, it needs an entry in `src/services/openapi.ts` and `.ssot/API.md`, and a
decision in `src/auth/policy.ts` about who may call it — `test/auth-coverage.test.ts` fails until you make it.

Anything an administrator does on the type that should be traceable is recorded through
`src/services/audit.ts`.

### 8. The secret list — ADR-0091

If the connector authenticates with a credential (a token, an API key, a password), three places must agree
that it does, and `CREDENTIAL_SOURCE_TYPES` in `src/services/encrypted-fields.ts` is the one list they read:

- the source service refuses a `secret` on any type not in the list (`checkSecretAllowed`);
- `scripts/backup.ts` counts only these types' credentials as what a wrong `SECRET_KEY` would destroy;
- `scripts/restore.ts` refuses a restore without the key only for these types, and drops a `secret_enc` it
  finds on any other.

Add the type to the list **only** if it holds a secret; a type that reads nothing private stays off it.
Secrets are encrypted at rest (`src/services/crypto.ts`), are never returned by the API (the view says
`hasSecret`), and never reach a log line or an error message — including the error your `test()` throws.
Strip them from every URL you print.

### 9. The dashboard — `public/app.js` and `public/index.html`

The dashboard has no build step and nothing links its tables to the server's list, so each of these is a
manual edit:

- `SOURCE_GLYPH` and `SOURCE_TITLE` in `app.js`: the badge and the name in the source list. A type missing
  here renders as `?`.
- `SOURCE_KINDS`: the dialog tab, with its title and subtitle.
- `index.html`: a `<button class="tab" data-kind="…">` and a `<div class="kind-only" data-kind="…">` form
  block with the fields. Give every input an id that the module looks up — `test/dashboard-wiring.test.ts`
  fails when an id the JavaScript uses is missing from the markup.
- `KIND_EXTENSIONS` if the type writes a narrower set of extensions than the default.
- If it holds a secret: `SECRET_FIELD` (type → form field name), which also feeds `CREDENTIALLED`, and
  `CLEAR_SECRET_ROWS`. If it supports the Test button: `TESTABLE`.
- The one-line summary of a source in the list (the per-type branch near `s.type === 'web'`).

### 10. Documentation, changelog, facts

- `docs/document-sources.md`: what the type is, what it needs, what it will not do.
- `README.md` and `DOCKERHUB.md`, where they list the types. These two are updated by hand and no test checks
  that a new type appears in them, so a forgotten line stays green; look for the other types' names in both.
- `CHANGELOG.md`, under `[Unreleased]`.
- `npm run build:facts`, then commit `public/product-facts.json`: the number and names of source types are a
  product fact the website checks itself against. Never edit that file by hand.

### 11. Tests

At minimum:

- a unit test of the driver against a stub of its client (`test/<type>-driver.test.ts`), including the
  failure paths: unreachable, unauthorised, empty, and over the ceiling;
- one that proves a secret stays out of the view, the logs and the errors;
- if it has a probe, one that proves `null` and a throw both mean "run it";
- an integration test (`test/integration/<type>-source.itest.ts`) for the end-to-end shape when the driver
  has behaviour a stub cannot show. It needs Docker, so it is not part of `npm test`.

## Check yourself

```bash
npm run lint
npm run typecheck
npm test
npm run db:check      # only if you changed the schema
npm run build:facts   # and commit the result
```

## What this guide deliberately leaves out

- **Loading a driver from outside the tree.** Not supported, by decision (ADR-0012).
- **Changing the real `SOURCE_TYPES` in a test.** `test/connector-guide.test.ts` registers a `dummy` driver
  and removes it again; the production list stays what the code says.
