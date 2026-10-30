# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

**Before `1.0.0`, a minor version may change a public contract** — the HTTP and MCP APIs, the MCP
tool names and their parameters, environment variable names — without a major bump. Once `1.0.0`
ships, that stops.

## [Unreleased]

## [0.6.0] - 2026-10-30

### Added

- **OIDC groups grant project memberships** (ADR-0134, amending ADR-0077; migration `0031_oidc_group_mappings`): set
  `OIDC_GROUPS_CLAIM` to the ID-token claim that lists a person's groups, and map groups to projects and a role
  (`viewer` or `editor`) under **Users → SSO group mappings** or `GET`/`POST /api/oidc/group-mappings` and
  `DELETE /api/oidc/group-mappings/:id` (`admin`; `409 mapping_exists`). Each SSO sign-in of a `member` account
  makes its group-granted memberships exactly the projects its groups map to (the higher role where two groups
  disagree); a person who has left a group loses the membership at their next sign-in. A membership added by hand
  wins and is never touched. A missing claim (omitted, `null`, `[]`, `{}`) means no groups; a claim that cannot be
  read (Entra's `_claim_names.groups` overage, not a list of strings, over 1 000 entries or a name over 256
  characters) stops a `member`'s sign-in with `groups_unavailable` and changes nothing. `admin` and `root` are
  skipped and no group changes an instance role. A group-granted membership is also removed when its mapping is
  deleted (recomputed in the same request), when its account unlinks SSO, and when a linked account signs in with
  its password. While the setting is on, the members API answers `409 membership_managed_by_group` for such a row;
  `GET /api/projects/:id/members` returns `origin` and `groups`. Every membership a sign-in changes is one audit
  event. Switching the setting off removes nothing. `GET /api/auth/me` carries `oidc.groups`. Helm chart 2.1.0:
  `config.oidcGroupsClaim`.
- **Token scope** (ADR-0133, amending ADR-0027; migration `0030_mcp_token_scope`): a static `ctxm_` token can be bound to
  a list of its project's sources, and a source outside the list does not exist for it in `search_docs`,
  `read_document` (by path and by suffix), `list_topics`, `whats_new` (added, modified and removed rows),
  `resources/list` and `resources/read`; the filter is in SQL, ahead of ranking, paging and counting. A source name
  outside the scope is answered as an unknown source. A scope whose sources were all deleted reads nothing, never the
  project. `POST /api/projects/:id/mcp-tokens` takes `sources` (names); the new
  `PATCH /api/projects/:id/mcp-tokens/:tokenId/sources` sets or (`null`) removes it, with `400 empty_scope`,
  `400 unknown_source` and `409 not_static`; `GET` returns `sources` and `scopeEmpty`; both writes are audited with the
  names. Panel: source choice when minting, a scope badge per token (red when empty) and a note on `open` projects,
  where a scope is not a boundary. OAuth credentials, API tokens and `/api/*` are unaffected. **Going back to a release
  before 0.6.0 widens every scoped token to its whole project: revoke scoped tokens before a downgrade.**
- `SOURCE_ALLOWED_HOSTS`: one allowlist of host names that Confluence sources (and the S3 and GitHub Enterprise
  Server sources of this release) may reach on a private address (ADR-0126, amending ADR-0088). Same format as
  the other allowlists; it does not admit a host for a web or git source. Helm chart: `config.sourceAllowedHosts`.
- Helm chart 2.1.0: `config.s3MaxObjects`, `config.gdriveMaxFiles`, `config.githubMaxIssues` and
  `config.githubMaxDiscussions` set `S3_MAX_OBJECTS`, `GDRIVE_MAX_FILES`, `GITHUB_MAX_ISSUES` and
  `GITHUB_MAX_DISCUSSIONS` (integers 1 to 100 000; `null`, the default, leaves the application default of 5 000).
- The AWS Signature V4 signer moved from `scripts/backup-s3.ts` to `src/services/s3/sigv4.ts`, so the backup
  command and the S3 source share one implementation. The backup command's behaviour is unchanged.
- Internal building blocks for the remote-store sources of 0.6.0: a one-JSON-document credential helper
  (ADR-0126 decision 8) and a shared list / version / download-what-changed / remove-what-is-gone routine with a
  per-type object ceiling.
- **S3 bucket source** (`s3`; ADR-0126): the objects under one prefix of an S3-compatible bucket (AWS S3, MinIO,
  Ceph, R2…), signed with SigV4 and read without an SDK. Incremental on the ETag: a scheduled check lists the
  prefix and downloads nothing, and a run fetches only objects that changed or appeared and drops those that are
  gone. The key pair is one encrypted `secret_enc` document (`{"v":1,"accessKeyId":…,"secretAccessKey":…}`;
  session tokens are refused); an endpoint on a private address needs `SOURCE_ALLOWED_HOSTS`. New setting
  `S3_MAX_OBJECTS` (default 5 000). Panel: an **S3 bucket** tab. The `s3` type joins the credential-bearing types
  of the backup's key check and the project export's manifest.
- **Google Drive source** (`gdrive`; ADR-0127): the files under folders shared with a Google service account.
  Docs are exported as Markdown, Sheets as `.xlsx` and Slides as `.pptx` (the last two converted like any upload);
  other files are downloaded as they are, and a Google file over Google's 10 MB export limit is refused by name
  while the run goes on. A scheduled check is one `changes.list` request; a run walks the folders and fetches only
  files whose Google version or checksum changed. No Google client library: the sign-in (RS256 JWT) and the Drive
  calls are the product's own, sent only to `oauth2.googleapis.com` and `www.googleapis.com` through the egress
  guard, which gained a `pinnedHosts` option for it. The key file is stored as one encrypted `secret_enc` document
  (e-mail, key id, private key). New setting `GDRIVE_MAX_FILES` (default 5 000). Panel: a **Google Drive** tab. The
  `gdrive` type joins the credential-bearing types of the backup's key check and the project export's manifest.
  Shared drives are not verified.
- **GitHub issues and Discussions source** (`github`; ADR-0128): the issues of one repository, and optionally its
  Discussions, one document each with its comments (`issues/<number>.md`, `discussions/<number>.md`); closed issues are
  opt-in and pull requests are never indexed. A token is optional: without one the source reads a public repository's
  issues under GitHub's anonymous limit, and `includeDiscussions` without a token is `400 invalid_request`. The token is
  the bare `secret` string, stored encrypted and counted by the backup's key check; the `github` type joins the credential-bearing
  types and the project export's manifest. A scheduled check is one conditional request (`ETag`, a free `304` with a token);
  a run reads only what changed since the last one, and deletions and transfers are found on the first run and on a run
  after `SYNC_MAX_SKIP_HOURS` (24 hours when that is off). A rate limit ends the run as `error` with the reset time and
  moves no cursor. GitHub Enterprise Server works through `apiBaseUrl` and `SOURCE_ALLOWED_HOSTS`. New settings
  `GITHUB_MAX_ISSUES` and `GITHUB_MAX_DISCUSSIONS` (default 5 000 each, placeholders until measured). Panel: a
  **GitHub issues** tab. The wiki and files stay with the `git` source.
- `/metrics`: `contextator_source_throttled_total{source_type}`, the throttling answers a source's remote gave (S3 `503 SlowDown`, Drive `429` and rate-limit `403`), counted per answer whether or not a retry then succeeded. The label set is closed (`s3`, `gdrive`) and every value is exported from start at `0` (ADR-0126 decision 9).
- Notion sources can be connected with OAuth ("Connect with Notion") instead of a pasted integration token
  (ADR-0129). Each operator registers their own Notion public connection and sets `NOTION_OAUTH_CLIENT_ID` and
  `NOTION_OAUTH_CLIENT_SECRET` (and `NOTION_OAUTH_REDIRECT_URI`, or `PUBLIC_BASE_URL`); with none set nothing
  changes. An editor starts it from the dashboard with a session; an API token or `ADMIN_TOKEN` cannot. The
  access and refresh token are stored encrypted in the source's existing secret, the source refreshes them when
  Notion refuses the access token, and a revoked connection ends the run asking for **Reconnect**. OAuth sources
  have no webhook; the schedule keeps them fresh. Startup is refused when only one of the id and the secret is set,
  when neither a redirect URI nor `PUBLIC_BASE_URL` is set, or when `SECRET_KEY` is missing.
- New routes `GET /api/sources/notion/oauth` (whether the flow is configured), `POST
  /api/projects/:id/sources/notion/oauth` and `GET /api/sources/notion/oauth/callback`.
- The PII scan (ADR-0130): after an index run, and once at startup for the whole corpus, stored documents are looked
  through for AWS access keys, GitHub tokens, PEM private key headers, JWTs, Turkish citizen numbers (valid check digits)
  and IBANs (valid mod-97). It only reports: nothing is masked or skipped and search is unchanged. Findings are listed
  by `GET /api/projects/:id/findings` for a project `editor` and above, as a masked preview and a short group id;
  without `SECRET_KEY` they are written without an HMAC. `PII_SCAN=0` stops new scanning. Migration `0029` adds
  `document_findings` and `document_scans`; `/metrics` gains `contextator_document_findings_total{rule}` and
  `contextator_document_scans_total{outcome}`; a project export counts the findings it leaves out
  (`excluded.documentFindings`).
- A "Secrets and personal data" section on the project page for an `editor` and above (ADR-0130): the PII scan's
  findings by document path, with the rule, the position and the masked preview, narrowed by rule. It never shows a
  value, and says separately that scanning is off (`PII_SCAN=0`), that findings are not grouped (no `SECRET_KEY`), that
  documents hit the per-document ceiling and that documents were cut when indexed. A viewer does not see it.
- A `contextator` command in both images (ADR-0131): `project create <name> --git <url> [--wait]`,
  `project status`, `token create` and `backup`, for CI and shells. The first three call the admin API with
  `CONTEXTATOR_URL` and `CONTEXTATOR_TOKEN` (a token is never an argument); `--wait` follows the index run, with a
  timeout; output is `--json` or lines, with distinct exit codes (`docs/cli.md`). `docker run … contextator <command>`
  runs it without starting a server or a database; `backup` is the existing backup under that name and needs the
  default image. A GitHub Actions example is in `docs/examples/`. No new dependency, and nothing is published to npm.
- An Agent Skill, `skills/contextator/SKILL.md`, for assistants that read the Agent Skills format: it says in what order to use
  `search_docs`, `list_topics`, `read_document`, `whats_new` and `report_gap` against a Contextator MCP endpoint, to cite the file
  path of every passage relied on, and to say so when the documentation does not cover a question. It adds no tool and changes
  no server behaviour.
- `test/agent-skill.test.ts` holds `skills/contextator/SKILL.md` to the Agent Skills specification (frontmatter fields and limits,
  `name` equal to its directory, under 500 lines) and to the code: every tool name the skill mentions must be in
  `MCP_TOOL_NAMES`, and every tool in `MCP_TOOL_NAMES` must be mentioned, so a tool added without updating the skill breaks
  the unit tests.

### Deprecated

- `CONFLUENCE_ALLOWED_HOSTS` (Helm: `config.confluenceAllowedHosts`). It still admits its hosts for Confluence
  sources only, and the server logs one warning at startup while it is set. Move its hosts to
  `SOURCE_ALLOWED_HOSTS`. It is removed no earlier than `1.0.0`.

### Security

- **A stored credential can no longer be redirected by editing a source's address.** An editor may write a source's
  settings but cannot read its token, yet `PATCH /api/projects/:id/sources/:sid` kept the stored credential when it changed
  the address the source calls, so pointing a Confluence `baseUrl`, a git `url`, an S3 `endpoint` or a GitHub `apiBaseUrl`
  at a host of one's own sent the token there on the next Test or sync (for git, any server that answers `401` is
  offered it). The request is now refused with `400 invalid_request` unless it also supplies the credential again.
  `gdrive` has no such setting: its hosts are pinned to Google's.

### Changed

- **Behaviour change for API clients:** changing the host (scheme, name or port) of a source's `baseUrl` (Confluence),
  `url` (git), `endpoint` (S3) or `apiBaseUrl` (GitHub) while a credential is stored now needs the credential in the
  same request, either the new value or `secret: null` to remove it. A change of path on the same host, an edit that
  leaves the address alone, and any edit of a source that stores no credential (a public git repository) are
  unchanged. In the dashboard the save is refused with a message naming the setting; type the token again and save.
- A Confluence source refused for resolving to a private address now names `SOURCE_ALLOWED_HOSTS`, not
  `CONFLUENCE_ALLOWED_HOSTS`, in its error message.
- A Notion `secret` sent through `POST`/`PATCH /api/projects/:id/sources` that starts with `{` is refused with
  `400 invalid_request`: that is the shape of an OAuth connection, which only the dashboard flow creates. No real
  integration token starts with `{`.
- A project export's manifest states, beside the other exclusions, how many `report_gap` reports stayed behind
  (`excluded.reportedGaps`), and so does the README in the archive. A manifest from an earlier version, without the
  field, is still read.

### Fixed

- The note `whats_new` appends when it cuts a list at `limit` told the client to ask again with a later `since`, which
  hides the older changes it was cut from; it now says to ask with a larger `limit` (at most 200), and, when the list
  was already cut at 200, to narrow the question with `source` or `version`.
- With `SEARCH_QUERY_LOG=0`, `search_queries` rows older than `SEARCH_QUERY_LOG_RETENTION_DAYS` are now swept too. The
  sweep sat behind the switch, so an instance that turned the log off kept what it had logged until somebody turned
  it back on. `reported_gaps`, the audit log and `document_changes` were already swept regardless.
- The CI `eval` job now also starts for a change to `package.json`, `package-lock.json` or `drizzle/`, so every
  dependabot pull request runs it.
- The Helm CI job checks that the values schema rejects `config.trustProxy` set to `1` and to `true`.
- An import that refuses an over-long line in an NDJSON file names the line (`documents.ndjson:12: ...`).
- The "three tools" wording in the dashboard's About page and in the demo docs now lists all five MCP tools, and
  `report_gap` is described as writing to its own table under the query log's policies rather than "to the query
  log".
- The dashboard no longer scrolls sideways on a phone-width screen. At 390 px the health strip in the top bar
  (database and model pills, the model id, open sessions, the version) ran past the viewport and widened the
  whole page to 573 px; below 720 px it now sits on its own row, wraps, and ellipsises the model id inside it.
  Wider screens are unchanged.

## [0.5.0] - 2026-10-26

### Breaking

- `TRUST_PROXY=1`/`true` (trust every hop of `X-Forwarded-For`) is refused at startup. The process exits with a
  non-zero code and a message that names the value and the way out (ADR-0122, which amends ADR-0060). It was
  deprecated in 0.4.1. **Before upgrading**, set `TRUST_PROXY` to `loopback` when the proxy runs on the same host,
  to the proxy's address or CIDR block (the proxy, not the network your clients are on: the list applies to every
  hop), or to `0` when nothing sits in front of the server. `0`, `false`, addresses, CIDR blocks and the subnet
  names are unchanged.
- Helm chart 2.0.0: the values schema rejects `config.trustProxy` set to `"1"` or `"true"` (any letter case), so
  `helm upgrade` stops before anything changes instead of the Pod going into a CrashLoop. A `TRUST_PROXY` set
  through the free-form `env` map is not seen by the schema; the application refuses it when the Pod starts. The
  chart README has an "Upgrading to chart 2.0.0" section.

### Added

- `whats_new(since, source?, version?, limit?)`, a fourth read-only MCP tool in both protocol eras: the documents
  added, changed or removed after a point in time, newest first, with the path `read_document` takes. Every answer
  says from when its record starts (`history_starts_at`) and whether `since` reaches back that far (`complete`), so
  an empty list is never mistaken for "nothing changed". A removed document returns only its path and title.
- Migration `0026_document_changes`: the latest change of every path a project has had (ADR-0123). The indexer
  writes it in the same transaction as the document, and a forced re-index records the difference between the
  old and the new generation in the transaction that swaps them. A change is a change of the document's text, so a
  force re-index of unchanged content, a changed source `language` or `version`, and the other documents of an
  OpenAPI specification when one operation changed record nothing. Deleting a source records its documents as
  removed. Changes are kept for 90 days (a constant, no new environment variable) and swept on the session
  reaper's timer, including when `SEARCH_QUERY_LOG=0`.
- The server asks a project's golden questions of its live index after the index changes, and keeps the answers
  (ADR-0124). Migration `0027_eval_runs`; `GET /api/projects/:id/eval-runs` and `GET .../eval-runs/:runId` (viewer),
  `POST /api/projects/:id/eval-runs` (manager, audited; `202`, or `409` while the project or the server is busy).
  A run is triggered by a swap, by an incremental run that wrote chunks, removed files or recorded document
  changes, by a change to the set (after 60 seconds without another) and by a manager. It is scored with the same
  module as `npm run eval -- --project`, and `regressed` is true when at least one question that was in the top five
  in the project's last good run is not now. The last 100 runs per project are kept, one run at a time on the
  server and one waiting per project, and the project's own lock is not taken, so indexing is never held up by
  one. `/metrics` gains `contextator_eval_runs_total`, `contextator_eval_run_errors_total` and
  `contextator_eval_regressions_total`, with no label.
- `report_gap(query, note?)`, the first MCP tool that writes, in both protocol eras (ADR-0125): an agent that
  searched and found the answer is not there tells the maintainers. It writes to its own table, migration
  `0028_reported_gaps`, never to documentation or to `search_queries`, and it answers `Received.` whether the report
  was stored, was over its limit or was dropped, so it returns no report, count or identity. It follows the query
  log: it is absent from `tools/list` under `SEARCH_QUERY_LOG=0` or when the project's query log is off, every call
  reads the project's switch again (a report after the switch was turned off is not written and is counted as
  `disabled`), rows are swept by `SEARCH_QUERY_LOG_RETENTION_DAYS` even while the log is off, and purging a
  project's query log removes its reports (`reportedGapsDeleted` is added to the answer). At most 2,000 reports are
  kept per project. `MCP_REPORT_GAP_PER_HOUR` (default `20`, `0` is off; Helm `config.mcpReportGapPerHour`) limits
  reports per credential per hour, with an open project's anonymous callers sharing one bucket. The Queries panel
  shows reports grouped by question in their own block on the Questions tab, as plain text, and
  `GET /api/projects/:id/queries/summary` gains `reportedGaps`. `/metrics` gains
  `contextator_mcp_gap_reports_total{outcome}` (`accepted`, `limited`, `disabled`, `failed`).
- The dashboard has an Eval runs panel under the golden questions: the history of recall@5 and MRR as a chart,
  the runs as a list with what each one lost or skipped, a warning naming the questions the newest good run lost
  (and the ones skipped for the first time), and a "Run now" button for a manager. It draws the figures the
  server recorded and scores nothing itself. A run the server starts by itself (after an index build, after the set
  was edited by anyone) shows up on an open page within seconds, without a refresh.
- `docs/configuration.md` has a guide to sizing `CONVERSION_WORKER_MAX_HEAP_MB` against the container's memory
  limit, with the measurements it rests on (peak resident memory and the smallest working cap for `.pptx`,
  `.xlsx` and `.pdf` inputs up to the 2000-page ceiling); the Helm chart README points to it next to
  `resources.limits.memory`. The setting still has no default (ADR-0097).
- `npm run eval -- --rerank-url <url>` (with `--rerank-latency <file>`) reranks the fused pool with a remote
  cross-encoder behind a TEI-compatible `/rerank` endpoint, and `scripts/eval-rerank-remote.ts` compares two
  reports. It is a measurement arm of the harness only: no remote reranker ships and the server's search path is
  unchanged. The gate it implements was measured with `bge-reranker-v2-m3` and not passed (`eval/BASELINE.md`), so
  the server does not offer remote reranking in 0.5.0.

### Changed

- "Every tool is read-only" no longer holds: no tool writes to documentation, and `report_gap` writes to the query
  log. `MCP_TOOL_NAMES` is now the set of tools the server knows and `tools/list` a conditional subset of it, which
  differ by exactly `report_gap` while the query log is off. `public/product-facts.json` lists the tool.
- `npm run eval -- --project` now skips a question whose `expectFile` is not in the project's live index, lists it
  and leaves it out of the figures, where it refused the run (ADR-0124). `--strict` keeps the refusal. The run
  still refuses when no question can be asked. `--project` no longer applies `SEARCH_RERANK=on`, since the server's
  search path does not rerank, so its figure is the one the server stores. The scoring module moved from
  `scripts/eval-scoring.ts` to `src/services/eval-scoring.ts`, so the server and the CLI call one copy.
- Starting with `RESET_VECTORS=1` now also forgets the record of document changes and starts it again from that
  moment (ADR-0123), in the transaction that deletes the documents. Without it the next run would have recorded the
  whole corpus as added.
- The swap that publishes a rebuilt index now shares one transaction with the insert of the changes it publishes
  (ADR-0123, which amends ADR-0039 decision 5). What a reader sees is unchanged: the old generation or the new one,
  never between. The `projects` row is locked from the swap `UPDATE` to the commit, so a setting saved in the panel
  at that instant waits for it.
- `index_runs.id` is now the id the run was given when it started, so a change can name the run that made it. The
  row is still written when the run finishes.
- CI: a failing unit or integration run now keeps the name of the failed test: failures are annotated on the run,
  and a JUnit report is uploaded as an artifact (90 days). The retrieval evaluation now also runs when a pull
  request changes a file the eval harness imports (`src/config.ts`, `src/context.ts`, `src/db/`, and the
  `src/auth/` and `src/mcp/` modules it reaches), not only `src/services/`; a unit test keeps that filter in step
  with the harness's imports. The MinIO image used by the backup integration test is pinned by digest.

### Removed

- The two `TRUST_PROXY=1`-only paths of the MCP token network allowlist (ADR-0118): saving a list answered `400`
  and a token that carried one answered `403` under that value. With the value refused there is no instance in
  which either can run. A request from an address outside a token's list is still answered `403`.

### Fixed

- A project import that refused a malformed line in `sources.ndjson`, `golden-questions.ndjson` or
  `documents.ndjson` named a line number that was too low whenever blank lines came before it; the number now
  counts every physical line, as an editor does.
- The dashboard's suggested relevance floor was read once per project, so a model change, a new generation or a
  different window on the questions panel left the old list on screen. It is read again when any of them changes, and
  after a model or generation change it keeps being read until the suggestion the server stores for the new encoder is
  there.
- Editing a golden question in the dashboard sent every field back, not the ones that were changed: a file path
  with padding or a tag that contains a comma, stored through the API or an import, was silently trimmed or split
  by saving an edit to the question's text. Only the fields that differ from what the form showed are sent now.
- The dashboard's quota panel could show old usage: when an index run moved the counts while a read was in
  flight, the slower, older answer landed last. A read now yields to a newer one.
- `docs/deployment.md` said a shared rate-limit key means nobody can guess faster than the budget allows. Anyone
  with an account of their own can reset the shared sign-in budget with a successful sign-in, so against other
  accounts only the per-account lockout bounds guessing; the text now says so.

### Upgrade notes

**The one change that can stop an upgrade.** `TRUST_PROXY=1` (or `true`) is refused at startup, so an instance
that still sets it does not come up until the value is changed (ADR-0122). Set `TRUST_PROXY=loopback` when the
proxy runs on the same host, the proxy's address or CIDR block when it does not, or `0` when nothing sits in
front. With Helm, `config.trustProxy` set to `"1"` or `"true"` fails `helm upgrade` against chart 2.0.0 before
anything changes. Nothing else below needs a change from you before you upgrade.

- **Three migrations run at start-up, in order:** `0026_document_changes`, `0027_eval_runs` and
  `0028_reported_gaps`. They only add tables and rewrite no existing row. Take a backup first, as for any upgrade
  (`npm run backup`).
- **`whats_new` starts with an empty record.** `history_starts_at` is the moment the migration ran (or the
  project's creation, if later), and every answer says so, so a question about an earlier date is answered
  `complete: false` rather than with an empty list.
- **The server now scores a project's golden questions by itself** after the index changes. It adds embedding work
  after an index build for projects that have questions, one run at a time on the server, and holds no project
  lock.
- **`tools/list` gains two tools**, `whats_new` and `report_gap`. `report_gap` is the first MCP tool that writes
  (only to its own table) and is absent while the query log is off: set `SEARCH_QUERY_LOG=0`, or switch a
  project's query log off, to keep it out.
- **New environment variable, optional:** `MCP_REPORT_GAP_PER_HOUR` (default `20`, `0` is off; Helm
  `config.mcpReportGapPerHour`).

## [0.4.2] - 2026-10-25

### Added

- `.asciidoc` is indexed as AsciiDoc, the same as `.adoc`. Like every converted type it is opt-in per source (#26).

### Fixed

- The dashboard's File types row now offers `.pptx`, `.xlsx`, `.ipynb`, `.rst`, `.adoc` and `.asciidoc`. The
  types added in 0.4.0 had no checkbox, so they could only be enabled through the API, and saving a source from
  the dashboard dropped them from its extensions. Helm chart 1.8.2 moves `appVersion` to 0.4.2 and changes
  no value.

## [0.4.1] - 2026-10-25

### Deprecated

- `TRUST_PROXY=1`/`true` (trust every hop) is deprecated and will refuse startup from 0.5.0; name the proxy
  instead (ADR-0122). **Nothing changes in 0.4.1:** the value still works, and the startup warning now says it
  will be refused. To migrate, set `TRUST_PROXY` to `loopback`, to the proxy's address or CIDR block, or to `0`
  when nothing sits in front of the server. Helm chart 1.8.1 drops `"1"` from the `config.trustProxy` comment
  and `helm install`/`upgrade` prints a deprecation note for `"1"` or `"true"`; the values schema still accepts
  both until chart 2.0.0.

### Changed

- Relevance floor audit events record the project's floor before and after (`detail.floorFrom` /
  `detail.floorTo`). Each is the number, or `"instance"` for a project that follows `SEARCH_SCORE_FLOOR`
  (ADR-0121). Earlier events keep the sentence they had; the API responses are unchanged.
- Source comments that pointed at README sections that have moved now point at where the facts live. No
  behaviour change.

### Fixed

- An upload archive that stops part-way (a file-size, entry-count or total-size limit) now counts the files it
  had already unpacked against the project's upload quota.

## [0.4.0] - 2026-10-25

### Added

- **Panel: provenance, quotas, allowlists, floors, freshness and golden questions.** Search hits show the
  clickable source link (`rel="noopener noreferrer"`), the source's modified date and a "long unchanged" marker.
  The project view shows the quotas with their usage and, for an administrator, edits them; a refused upload
  (`413`) is worded in documents, chunks or bytes. The token list edits each token's address allowlist and
  explains the rate limits; the query log filters by MCP token; the relevance floor panel measures, shows and
  applies suggested floors (a dismissal is kept in the browser only, the server has no reject route); each
  source row shows its last sync and whether it is current, overdue or never synced (the admin API's
  `lastSyncedAt`; `/metrics` stays unlabeled, ADR-0119). A new Golden questions panel lists, adds, edits,
  deletes and exports the project's set and shows the `npm run eval -- --project <name>` command; the
  evaluation itself stays a command-line tool. No server change.
- **Evaluate your own corpus and questions.** `npm run eval -- --corpus <dir> --golden <file>` indexes a directory
  of yours and asks a question file of yours with the scoring `npm run eval` already uses; `--negative <file>`
  adds refusal questions (never defaulted for a custom set, ADR-0045). A project now keeps a question set of
  its own: `GET`, `POST` and `PUT` on `/api/projects/:id/golden-questions`, `GET`, `PATCH` and `DELETE` on
  `.../:questionId`, and `GET .../export` returning it as a `golden.jsonl` (viewer reads, editor writes, at most
  1000 questions). `npm run eval -- --project <name>` asks those questions of the project's live index and
  refuses a project that has nothing indexed, was indexed with another model, or has no questions. A project
  export carries the set as an optional `golden-questions.ndjson`; older exports still import and the manifest
  version does not move (ADR-0051). Without the new flags `npm run eval` prints the figures it did before.
  Migration `0025_golden_questions`.
- **MCP rate limits.** `MCP_RATE_LIMIT_PER_MINUTE` (per token, default `0`), `MCP_RATE_LIMIT_ANON_PER_MINUTE`
  (per address on an open project, default `60`) and `MCP_RATE_LIMIT_TOOLS` (`name=count`) limit MCP requests in a
  fixed one-minute window kept in the new `mcp_rate_limits` table. A request over a limit is answered `429` with
  `Retry-After` and a JSON-RPC `-32000` error (`rate_limited`, with `retryAfterSec` and `scope`). Notifications,
  `initialize`, `ping`, event streams and failed authentication are not counted. If the counter cannot be
  reached the request is served and `contextator_mcp_rate_limit_errors_total` rises; `MCP_RATE_LIMIT_FAIL_OPEN=0`
  answers `503`. New metric `contextator_mcp_rate_limited_total{scope}` (ADR-0112). Migration `0023_rate_limit_allowlist`.
  **Upgrade note:** an open project now answers at most 60 requests a minute per client address; set
  `MCP_RATE_LIMIT_ANON_PER_MINUTE=0` to keep the old behaviour. Nothing else changes until a limit is set.
- **Network allowlist for a static MCP token.** A token can carry up to 32 addresses or CIDR ranges
  (`allowedCidrs` on `POST /api/projects/:id/mcp-tokens` and the new `PATCH /api/projects/:id/mcp-tokens/:tokenId`).
  A request from elsewhere is answered `403` without naming the address or the ranges, logged with the token id
  and the address, and counted in `contextator_mcp_access_denied_total{reason="network"}`. A list cannot be saved
  under `TRUST_PROXY=1`, where the address is client-controlled (ADR-0118). `docs/mcp-access.md` has the
  `TRUST_PROXY` table. Helm chart 1.6.0 exposes the rate limits as `config.mcpRateLimitPerMinute`,
  `config.mcpRateLimitAnonPerMinute`, `config.mcpRateLimitTools` and `config.mcpRateLimitFailOpen`.
- **Query log by token.** The query log summary and export take `token` (an MCP token id) and show only what
  that token asked.
- **Relevance floor suggestions.** After a re-index caused by an embedding-model change, and on request
  (`POST /api/projects/:id/score-floor/suggestions`, manager), the server measures the project with the floor
  off and stores the highest floor that still answers a fragment of each of up to 100 of its own chunks (the
  last eight words of a sentence, or the tail of a Chinese or Japanese sentence weighing 16, a character counting 1 and a Latin word 2, never the heading; Thai, Lao, Khmer and Burmese are not recognised). The suggestion is mostly an upper bound, not a guarantee: on the four
  reference corpora it came out within 0.013 of the floor fitted from labelled questions, on either side of it, on
  two (prose documentation) and 0.027 to 0.045 above it on the other two (XQuAD); two runs on one project can differ
  by 0.018. Check it with `GET .../score-floor/preview` in both directions before applying it. Suggestions are
  listed (`GET`, viewer) and adopted only by `POST .../suggestions/:suggestionId/apply` (manager); the project's
  floor is never changed automatically, and a suggestion from an earlier model or index generation is refused.
  One measurement runs per project and at most two across the server; a further request from an operator gets `409`,
  while the one the server makes after a model change waits its turn.
  The fit is shared with `scripts/floor-calibration.ts`. Migration `0024` adds the `floor_suggestions` table
  (ADR-0083).
- **Re-index on embedding-model change.** With `REINDEX_ON_MODEL_CHANGE=1` (off by default; Helm chart 1.7.0
  `config.reindexOnModelChange`), start-up queues one scheduled run for every project stamped with a different
  model than the server runs and that has at least one source, scheduled or not. A project that was never
  indexed or has no source is left alone, and the flag off behaves as before (ADR-0113).
- **Default auth and bind address as product facts.** `public/product-facts.json` gains `defaultMcpAuth`
  (read from `DEFAULT_MCP_AUTH`) and `defaultBindAddress` (the address the compose files publish the port
  on). The bind address is read from `docker-compose.yml` and `docker-compose.slim.yml` with a YAML parser;
  `npm run build:facts` fails if they disagree or if the `${CONTEXTATOR_BIND:-…}` expression changes shape
  (ADR-0114). The README claims about both are tested against the facts.
- **Contributing a connector.** `docs/contributing-a-connector.md` lists every place a new source type touches,
  in order, and `test/connector-guide.test.ts` registers a throwaway driver through those steps so the guide
  cannot drift from the code. `CONTRIBUTING.md` links it. No plugin loader is added (ADR-0012).
- **One-click deploy templates.** `deploy/railway/`, `deploy/render/` and `deploy/fly/` set up the `-slim` image
  with a PostgreSQL and a volume on Railway, Render and Fly.io; `docs/deployment.md` has the steps for each.
  Projects stay token-protected, the first-run page needs `SETUP_CODE`, and `test/deploy-templates.test.ts`
  fails if a template carries a setting that opens authentication.
- **Startup warning for open projects on a reachable address.** When the server listens on a non-loopback
  address and at least one project has no MCP token, the log says which projects (ADR-0065). Said once at
  start; nothing changes for a loopback bind or for token-protected projects. It cannot see how a container's port is
  published, so it says that a loopback-only publish makes it safe to ignore.
- **Per-project quotas.** A project can be capped on documents, chunks and upload bytes. `PROJECT_MAX_DOCUMENTS`,
  `PROJECT_MAX_CHUNKS` and `PROJECT_MAX_UPLOAD_BYTES` set the instance default (`0`, the default, is unlimited);
  `PATCH /api/projects/:id/quotas` gives one project its own value, `0` to exempt it or `null` to follow the
  instance again, and is audited. `GET /api/projects/:id` is new and shows each quota's limit, current use and
  whether it is inherited. An upload that would go over the cap is refused with `413 quota_exceeded` and
  nothing from it is kept; an indexing run that would go over the document or chunk cap ends in `error` with
  `quota_exceeded` (a rebuild keeps serving the previous generation, an incremental run keeps the documents it
  had finished). Quotas travel in a project export. Migration `0022_project_quotas`. Helm chart 1.5.0 exposes
  the three defaults as `config.projectMaxDocuments`, `config.projectMaxChunks` and `config.projectMaxUploadBytes`.
- **Idle upload sessions are swept.** An upload session that has had no `files` request and no commit for 24
  hours is deleted, with its staged files, by a sweep that runs every quarter of an hour, so the upload quota
  and the disk agree. Uploads that were not committed within 24 idle hours are lost. This applies to every
  project, with or without an upload quota.
- **Source freshness metrics.** `/metrics` gains `contextator_source_last_sync_timestamp_seconds` and
  `contextator_source_freshness_lag_seconds`, which describe the scheduled source that has gone longest
  without a successful sync, and `contextator_sources_never_synced`. They are single, unlabeled series:
  a `project` or `source` label would take its values from the data, which ADR-0105 rules out. Both
  timestamp/lag series are absent until a scheduled source has synced. `docs/observability.md` has example
  Prometheus alert rules.
- **Grafana dashboard.** `docs/observability/grafana-dashboard.json` covers MCP traffic and latency, search
  latency, source freshness and indexing, from series `/metrics` already renders. The Helm chart 1.3.1 README
  shows how it goes with the ServiceMonitor.
- **Opt-in OpenTelemetry traces.** Setting `OTEL_EXPORTER_OTLP_ENDPOINT` (and optionally
  `OTEL_SERVICE_NAME`) exports a trace per search over OTLP/HTTP, with spans for the query, the embedding, the
  candidates, the reranker (when one is configured), the score-floor verdict and the response, and joins
  the caller's trace when the request carries a `traceparent` header. A failing export is logged, at most
  once a minute. Unset, the OpenTelemetry packages are never loaded. The packages are optional
  dependencies. The SDK also reads some `OTEL_*` variables of its own (sampler, batching, exporter
  headers); the ones that apply are listed in `docs/observability.md`.
- **Every answer says where the document came from.** `search_docs`, `read_document` and the HTTP search API
  now carry `sourceUrl` (git: a commit-sha permalink with any credential stripped; Notion and Confluence: the
  page; web: the final URL after redirects; `null` for local directories and uploads) and `sourceModifiedAt`
  (git: the HEAD committer date of the run in which the indexer first saw the current text of the file, kept
  while that text is unchanged and across rebuilds; Notion `last_edited_time`, Confluence version time, web
  `Last-Modified`, local file `mtime`), plus a `stale` flag. The text answers gain a `Source:` line under the frozen first line of each
  hit and after `Title:` in `read_document`; the structured output schemas gain the three fields. Only `http(s)`
  links are stored. `SOURCE_STALE_AFTER_DAYS` (default `365`, `0` = off) sets when a document unchanged at its
  origin is marked stale. A git link is built only for GitHub, GitLab, Gitea/Forgejo and Bitbucket Cloud
  (a self-hosted Bitbucket gets none rather than a wrong one). Migration `0021` adds `documents.source_url` and `documents.source_modified_at`, and
  project export and import carry them (ADR-0116).

  **Upgrade note:** existing documents start with both columns empty. They are filled in on each source's next
  index run without re-embedding anything; until then answers show no `Source:` line for them.

- **Backups to S3-compatible storage, and a Helm CronJob.** `npm run backup -- --s3` uploads the
  archive to a bucket (AWS S3, MinIO, Ceph, R2; path-style, SigV4 signed with `node:crypto`, multipart
  for large archives, no new dependency) configured by `BACKUP_S3_*`, and applies `BACKUP_KEEP` to the
  timestamped archives under the prefix. `npm run restore -- --s3 <name|latest>` restores from the
  bucket. Helm chart 1.4.0 gains an optional `backup.*` CronJob (off by default; credentials from an
  existing Secret, such as one created by the External Secrets Operator). The local-disk backup and the
  manifest format are unchanged (ADR-0120, which extends ADR-0110).
- **PowerPoint, Excel, Jupyter, reStructuredText and AsciiDoc files.** A source can now index `.pptx`
  (one section per slide, speaker notes on a `Notes:` line), `.xlsx` (one section per visible sheet,
  cached formula values, hidden sheets skipped), `.ipynb` (markdown and code cells, no outputs), `.rst`
  and `.adoc` (heading hierarchy kept). They are opt-in per source like the other converted types, and
  the Office types share the `MAX_DOCX_UNPACKED_BYTES` guard with `.docx` (ADR-0115).
  What those types convert to is bounded by `MAX_CONVERTED_FILE_BYTES` as well: a file whose output would
  pass it is refused by name, and an `.adoc` attribute that expands past 4 KiB is left undefined.
- **Scheduled backups for the slim stack.** `docker-compose.backup.yml` is an optional overlay for
  `docker-compose.slim.yml` that runs `npm run backup` against the external database once at start and
  then every `BACKUP_INTERVAL_SECONDS` (default one day), keeping the newest `BACKUP_KEEP` (default 7)
  timestamped archives in `/data/backups`. It uses the default image for its PostgreSQL tools, runs as
  UID/GID `1000:1000` like the slim app and shares its data volume and `.env`. The README also shows
  how to take an on-demand backup and run a restore on the slim stack, which have to run from the
  default image because the slim image has no `pg_dump` (FR-648, ADR-0110).

### Changed

- **README restructured.** The README now follows the standard section order. The long reference sections
  (document sources, accounts, MCP access, admin API, file types, troubleshooting) moved to `docs/`. The
  backup and PostgreSQL major-upgrade procedures stay in the README.

### Upgrade notes

**The one behaviour change.** An `open` project now answers at most 60 MCP requests a minute per client
address; the 61st within the minute gets `429` with `Retry-After`. It is on by default
(`MCP_RATE_LIMIT_ANON_PER_MINUTE=60`) because an open project is reachable by anyone and had no ceiling at
all. Set `MCP_RATE_LIMIT_ANON_PER_MINUTE=0` to keep the old behaviour. Behind a reverse proxy the address is
the client's only with `TRUST_PROXY` set; without it every caller shares the proxy's address and its one
budget (ADR-0112, FR-650). Everything else below changes nothing until you set a value.

- **Five migrations run at start-up, in order:** `0021_document_source_url`, `0022_project_quotas`,
  `0023_rate_limit_allowlist`, `0024_floor_suggestions` and `0025_golden_questions`. They only add columns
  and tables and rewrite no existing row. Take a backup first, as for any upgrade (`npm run backup`).
- **`source_url` and `source_modified_at` start as null** on every existing document. Search and
  `read_document` show no `Source:` line for a document until its source has run again; that run fills
  both in without re-embedding anything.
- **New environment variables, all optional:** `MCP_RATE_LIMIT_PER_MINUTE` (default `0`, off),
  `MCP_RATE_LIMIT_ANON_PER_MINUTE` (default `60`, see above), `MCP_RATE_LIMIT_TOOLS` (empty),
  `MCP_RATE_LIMIT_FAIL_OPEN` (`1`), `PROJECT_MAX_DOCUMENTS`, `PROJECT_MAX_CHUNKS` and
  `PROJECT_MAX_UPLOAD_BYTES` (default `0`), `SOURCE_STALE_AFTER_DAYS` (`365`), `REINDEX_ON_MODEL_CHANGE`
  (`0`), `OTEL_EXPORTER_OTLP_ENDPOINT` (unset, tracing off), `OTEL_SERVICE_NAME` (`contextator`) and, for
  `npm run backup -- --s3`, the `BACKUP_S3_*` family, plus `BACKUP_KEEP` (`7`, how many archives `--s3` and
  the compose sidecar keep) and the sidecar's own `BACKUP_INTERVAL_SECONDS` (`86400`). `.env.example`
  documents each of them except `BACKUP_INTERVAL_SECONDS`, which only the backup sidecar reads and the README documents.
- **Quotas default to `0`, which is unlimited,** instance-wide and per project, so no project is refused
  anything after the upgrade. A project's own `max_documents`, `max_chunks` or `max_upload_bytes` overrides
  the instance value in both directions, and `0` exempts that project.
- **The optional compose backup sidecar** (`docker-compose.backup.yml`, ADR-0110) is not started by the
  default compose files; nothing changes unless you add the overlay.
- **Helm chart `1.8.0`** (`appVersion` `0.4.0`). This release changes nothing in the chart but those two
  fields: the 0.4.0 values arrived in `1.3.1` to `1.7.0`, and an existing `values.yaml` keeps working.
- **The README is restructured.** Links into its old long sections now land in `docs/`.

## [0.3.2] - 2026-10-10

### Security

- **Every HTTP response body a git source reads is now size-limited.** A malicious remote could stream
  an unbounded packfile (or ref advertisement) and exhaust the server's memory, because isomorphic-git
  collects a response in memory. A response whose `Content-Length` is over the limit is refused before its
  body is read, and a body that grows past it is cancelled; either way the sync fails with an error that
  names `GIT_MAX_PACK_BYTES`. This covers the ref advertisement, `ls-refs` and `git-upload-pack`
  responses, including the ref requests where isomorphic-git would otherwise swallow the error
  (ADR-0109).

### Added

- **`GIT_MAX_PACK_BYTES`.** The most bytes one response from a git remote may carry. Default 256 MiB
  (`268435456`), at least 1 MiB. Helm chart 1.3.0 exposes it as `config.gitMaxPackBytes`. `.env.example`
  now also documents `GIT_ALLOWED_HOSTS` and `WEB_ALLOWED_HOSTS`.

### Upgrade notes

- A git source whose repository has a packfile larger than 256 MiB fails its sync after this upgrade
  until `GIT_MAX_PACK_BYTES` (Helm: `config.gitMaxPackBytes`) is raised. Memory peaks near twice the
  limit, because isomorphic-git copies the pack once more, so raise the memory limit together with it.

## [0.3.1] - 2026-10-10

### Security

- **Web and git sources now go through the egress guard.** In `0.3.0` and earlier a web source's
  requests (pages, `robots.txt`, sitemaps, `llms.txt`) and a git source's (`clone`, `fetch` and the
  ref listing behind Test and the change check) were made with no address check, so an editor could make
  the server request the cloud metadata address, its own loopback services or a host on the internal
  network. Every request now goes through the guard Confluence already uses
  (ADR-0088): the check runs after DNS, on the address the connection is opened
  to, and again on every redirect hop, with at most 5 redirects followed. A git source's credential does
  not follow a redirect to another host. Notion and OIDC fetches stay outside the guard: their hosts are
  not an editor's to choose.
- **The guard's private ranges now include `100.64.0.0/10` (carrier-grade NAT; the range Tailscale
  assigns from) and `198.18.0.0/15` (benchmarking), and `240.0.0.0/4` is refused under a new `reserved`
  rule that no allowlist lifts.** `255.255.255.255` is included; IPv4-mapped and NAT64 addresses are
  judged as the IPv4 address they carry. This applies to every path that uses the guard: Confluence,
  web sources, git sources and OAuth client metadata documents (which have no allowlist, so the two
  new private ranges are always refused there).
- **A credential pasted into a git source's URL (`https://user:token@host/...`) is no longer stored or
  returned.** It is stripped on create, update and project import, from the source view as well, and
  migration `0020` removes it from rows already stored; authentication still uses the encrypted token
  alone.

### Added

- **`WEB_ALLOWED_HOSTS` and `GIT_ALLOWED_HOSTS`.** Comma-separated host names (no scheme, port or path)
  that a web source, respectively a git source, may reach on a `private` address — the same format and
  meaning as `CONFLUENCE_ALLOWED_HOSTS`. The three lists are separate: a host listed for one source type
  is not admitted for another. A refusal names the rule and, for a private address, the list that would
  admit it. Helm chart 1.2.0 exposes them as `config.webAllowedHosts` and `config.gitAllowedHosts`.

### Changed

- **Breaking:** a web source that reads a host on the internal network stops working until that host is
  listed in `WEB_ALLOWED_HOSTS`, and a git source whose remote is on the internal network stops working
  until it is listed in `GIT_ALLOWED_HOSTS`. This includes hosts that resolve to `100.64.0.0/10` or
  `198.18.0.0/15`. The source's status and Test message name the rule and the setting. A host that
  resolves to loopback, link-local, `240.0.0.0/4` or another always-refused address cannot be listed.
- **Breaking:** `POST /api/tokens` answers a past `expiresAt` with `validation_failed` and an `issues`
  entry on `expiresAt` (`must be in the future`), as it does for every other field error, instead of
  `{ "error": "expiresAt must be in the future" }`. A client that matched on that body has to read
  `issues`.

### Fixed

- **SECURITY.md lists GitHub private vulnerability reporting and `security@contextator.com`** as the two ways to report a vulnerability, replacing the note that the former was not switched on yet.
- **In `account` mode, the Members screen now describes the MCP endpoint correctly.** Its note used the
  "open" wording, saying membership does not govern the MCP endpoint; it now says membership is the
  access, in the same words as the MCP access panel.
- **The Notion sync hints no longer promise what the check does not do.** They now say that a page
  unshared from the integration sends no event and is dropped by the next full sync, and, if nothing
  else triggers one, by the interval's check after `SYNC_MAX_SKIP_HOURS` (24 hours by default).

### Upgrade notes

- **List your internal hosts before upgrading.** For every web source whose site, and every git source
  whose remote, is on a private address — RFC 1918, `fc00::/7`, or now `100.64.0.0/10` and
  `198.18.0.0/15` — set `WEB_ALLOWED_HOSTS` or `GIT_ALLOWED_HOSTS` to its host name
  (for example `WEB_ALLOWED_HOSTS=docs.corp.example`, `GIT_ALLOWED_HOSTS=git.corp.example`), or with the
  Helm chart (1.2.0 or later; earlier versions reject these keys) set `config.webAllowedHosts` and
  `config.gitAllowedHosts`. Until then those sources fail
  their next sync and Test with a message naming the setting. Sources on public hosts are unaffected.
  A Confluence host that resolves to one of the two new ranges needs `CONFLUENCE_ALLOWED_HOSTS` too.
- **Migration `0020` runs at startup** and strips credentials from stored git source URLs; it changes no
  other row.

## [0.3.0] - 2026-10-03

### Added

- **`EMBEDDING_TOKENIZER` counts chunk tokens with a real tokenizer for `EMBEDDING_PROVIDER=openai`.**
  Name a Hugging Face model (e.g. `Xenova/multilingual-e5-small`); only its tokenizer is loaded, through
  the existing transformers.js dependency, at startup — and startup stops if it cannot be. Unset, chunks
  are sized by characters ÷ 4 exactly as before and the model id is unchanged; set, it becomes part of the
  model id, so turning it on re-indexes every project once. A self-hosted endpoint whose model name matches
  no prefix family is now reported once at startup.
- **Search and indexer histograms on `/metrics`.** Every answered search, from MCP and from the dashboard,
  is timed: `contextator_search_duration_seconds{phase,indexing}` times query embedding, retrieval (the hybrid statement) and reranking separately;
  `contextator_search_request_duration_seconds{indexing}` gives the search p95 while an index run is in
  progress and while it is not. `contextator_embedding_batch_duration_seconds`,
  `contextator_embedding_batch_size` and `contextator_index_run_wait_seconds{lane}` cover the indexer.
  No label carries a project, document or query. The README's *Scaling signals* section says which
  thresholds mean one process is no longer enough.
- **MCP protocol 2026-07-28 on the same `/mcp/:project` URL, beside 2025-11-25.** A request whose body
  carries the 2026 `_meta` envelope is served statelessly — no `initialize`, no `Mcp-Session-Id`, nothing
  added to the session registry — and `server/discover` is answered; every other request (an
  `initialize`, a request on a session, a body without the envelope) takes the session path exactly as
  before. GET, HEAD and DELETE on `/mcp/:project` and the HTTP+SSE routes stay 2025-era only. A modern
  request for a project that does not exist gets `404` with JSON-RPC `-32602`. Each tool call now reads
  its token from its own request, so a search is attributed to the token that made it even when a
  legacy session's client changes tokens mid-session, and a revoked token is refused with `401` in both
  eras. A modern call to a tool that does not exist gets the 2026 protocol error, JSON-RPC `-32602`
  `Tool <name> not found`; a legacy client still gets the `isError: true` tool result it got before.
- **2026-07-28 answers are structured and carry a per-project cache hint.** A modern client always gets
  each tool's `outputSchema` and a `structuredContent` beside the text, whatever `MCP_STRUCTURED_OUTPUT`
  says; the flag now governs legacy (2025-11-25) clients only, still off by default. Modern `tools/list`,
  `resources/list` and `resources/read` carry `ttlMs` — a tenth of the time since the project's last
  successful index, capped at an hour, `0` while indexing or before the first index — and
  `cacheScope: "public"` only on an `open` project (`private` otherwise); every other modern result keeps
  the SDK default, and `tools/call` carries none. A failed index run also gives `0`; deleting a source
  or changing the project's MCP auth mode does not reset the hint, so a client may see the earlier
  answer for up to an hour. None of this reaches legacy answers: they gain no `resultType`, `ttlMs` or
  `cacheScope`.
- **OAuth clients can identify themselves by a Client ID Metadata Document URL.** The authorization
  server metadata now says `client_id_metadata_document_supported: true`; a client that sends an
  `https://` URL with a path as its `client_id` needs no `/oauth/register` call. The document is fetched
  through the same egress guard as Confluence (no loopback, link-local, private or unspecified address,
  checked after DNS and on every redirect, https only), limited to 5 KiB and 5 s, and cached as its
  `Cache-Control`/`Expires` headers allow (5 minutes without them, a day at most). Its `client_id` must
  equal the URL, `client_name` and `redirect_uris` are required, no secret is accepted, and the requested
  `redirect_uri` must be listed exactly. The consent page names the host that published the document and
  where the answer is sent, and warns when the client can only redirect to localhost. Dynamic client
  registration is unchanged.
- **The 2026-07-28 standard request headers are enforced, by the SDK.** A modern request must repeat its
  protocol version in `MCP-Protocol-Version`, its method in `Mcp-Method`, and — on `tools/call`,
  `resources/read` and `prompts/get` — the tool name, URI or prompt name in `Mcp-Name` (a `=?base64?…?=`
  value carries a non-ASCII one). A missing or disagreeing header gets `400` with JSON-RPC `-32020`, an
  unsupported protocol version `400` with `-32022`, an envelope missing a field `400` with `-32602`, an
  unknown method `404` with `-32601`. A 2025-11-25 request is not asked for any of these headers.
- **MCP traffic on `/metrics`.** `contextator_mcp_requests_total{method,tool,era}` counts every MCP
  message by method, by tool for `tools/call`, and by protocol era (`modern` or `legacy`), so the last
  2025-era client's departure is visible; `contextator_mcp_tool_duration_seconds{tool}` times each tool
  call. A method or tool name the server does not know is counted under `other`, so a client cannot add
  series.
- **Two MCP prompts per project, in both protocol eras.** `answer_from_docs` (argument `question`) and
  `explore_topic` (argument `topic`) return one user message that tells the model which tools to use and
  to cite file paths. They read nothing and change nothing; `initialize` now advertises the `prompts`
  capability.

### Changed

- **The MCP server is built on the MCP TypeScript SDK 2.x** (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/server-legacy`, `@modelcontextprotocol/node`, pinned with `~`). The 1.x
  `@modelcontextprotocol/sdk` package remains a development dependency only, as the client the legacy
  tests drive.
- **Breaking:** legacy (2025-11-25) clients now get `-32602` (Invalid params) for a resource that is not
  found, and for `resources/list` on a project that no longer exists, where they previously got
  `-32002`; the error's `message` and `data` are unchanged. A client that matched on `-32002` has to
  match on `-32602`. The SDK applies the same code in both protocol eras, and no compatibility shim is
  provided.
- **Breaking:** the input schemas `tools/list` returns to legacy (2025-11-25) clients declare JSON Schema
  draft 2020-12 (`"$schema": "https://json-schema.org/draft/2020-12/schema"`, previously draft-07), and
  the tools no longer carry `execution.taskSupport`. The properties, types and constraints of each
  schema are unchanged. A client that validated against draft-07 or read `execution.taskSupport` has to
  be updated.
- **Breaking:** the text of a tool's input-validation error changed. It no longer starts with
  `MCP error -32602:` and lists each problem as `<field>: <message>`, comma-separated — for example
  `Input validation error: Invalid arguments for tool search_docs: query: Too small: expected string to
  have >=1 characters, limit: Too small: expected number to be >=1`. The result is still a tool result
  with `isError: true`; only a client that parsed the text is affected.

### Fixed

- **A project import is refused with `507 insufficient_disk` when the disk cannot hold it**, instead of
  failing half-way. `POST /api/projects/import` and `importProject` check `DATA_DIR` (and, with the
  embedded database, its data directory) for `DATA_DIR_MIN_FREE_BYTES` plus 4 × the archive's size
  before the upload is read and again before it is unpacked — before any project row or file exists.
  `DATA_DIR_MIN_FREE_BYTES=0` still turns the check off.
- **The README and the Helm chart 1.1.1 README describe what `npm run backup` prints in a `-slim`
  container.** Both said the command "stops with `no_pg_tools`"; the output says `pg_dump` is not on
  the `PATH` and never prints the refusal code, so both now give the code only in parentheses. The
  Kubernetes backup and restore steps were run end to end on a `kind` cluster against PostgreSQL 16
  and 17 (including the client-17 install) and otherwise stand as written. No template changed.

## [0.2.1] - 2026-10-02

### Added

- **`EMBEDDING_PROVIDER=openai` talks to any OpenAI-compatible endpoint.** `EMBEDDING_BASE_URL`
  (http or https, no credentials in the URL) points it at Ollama, vLLM, Text Embeddings Inference,
  LM Studio or a proxy; `OPENAI_BASE_URL` is still read when it is empty, and the base URL is now
  passed to the client explicitly instead of being picked up from the process environment by the SDK.
  `OPENAI_BASE_URL` is validated only when it is read: `EMBEDDING_PROVIDER=openai` and
  `EMBEDDING_BASE_URL` empty. `OPENAI_API_KEY` becomes optional when the base URL names a host other
  than `api.openai.com` — without one, no `Authorization` header is sent. A self-hosted endpoint is
  asked for float vectors rather than the SDK's base64.
  `EMBEDDING_REQUEST_DIMENSIONS` (`auto` by default: only `text-embedding-3-*`, as before; `always`;
  `never`) decides whether the request carries `dimensions`. The existing `EMBEDDING_QUERY_PREFIX` /
  `EMBEDDING_PASSAGE_PREFIX` and `EMBEDDING_MAX_INPUT_TOKENS` apply to this provider unchanged.
  An installation that already set `OPENAI_BASE_URL` keeps its model id and its index: the legacy
  name never enters the id (see Changed).
- **Every OAuth authorization response names its issuer (RFC 9207).** The redirect back to an MCP
  client now carries `iss` on a code and on an error alike, and the authorization server metadata
  announces it with `authorization_response_iss_parameter_supported: true`. A client that talks to
  more than one authorization server can now tell which one answered; one that ignores `iss` sees no
  difference.
- **Dynamic client registration reads `application_type` (RFC 7591).** `native` may register an
  `http` loopback callback (`127.0.0.1`, `[::1]`, `localhost`) on whatever port it picks, which the
  authorization request must then repeat exactly, or a private-use scheme such as
  `com.example.app:/callback`; `web` may register `https` on a non-loopback host only and is answered
  `invalid_redirect_uri` otherwise. An unknown value is `invalid_client_metadata`. A registration that
  leaves the field out is checked exactly as before.
- **Uploads, and forced re-indexes on the embedded database, are refused on a nearly full disk.**
  Below `DATA_DIR_MIN_FREE_BYTES` free (default 512 MiB, `0` turns it off) the request answers `507`
  with `error: "insufficient_disk"` and a message naming both figures and the disk. Uploads — the
  request that opens a session and every request that adds files to it — are checked against
  `DATA_DIR`'s file system. A forced re-index writes its new generation into the database, not into
  `DATA_DIR`, so it is checked against the embedded PostgreSQL's data directory; a rebuild that starts
  from the queue (a queued force, a model change) is checked again when it starts and fails the same
  way, leaving the live index as it was and the message in the project's error. **With an external
  database (`DATABASE_URL`) the database's disk cannot be measured from Contextator, so forced
  re-indexes are not checked at all** — watch that disk where the database runs. The check is
  advisory: passing it means the disk was not already below the threshold, not that the work will
  fit. `/api/health` reports `DATA_DIR`'s `disk: { freeBytes, totalBytes, minFreeBytes, ok }` to a
  signed-in caller; it does not change `ok` or the status code, which still report the database.
- **`CONVERSION_WORKER_MAX_HEAP_MB` caps the conversion thread's heap (opt-in).** Unset — the
  default — means no cap, as before. When set, a file whose conversion needs more than that many MiB
  becomes one refused document whose reason names the heap limit, distinct from a timeout or a crash;
  the thread is replaced and the run carries on with the next file (ADR-0097).
- **`CONFLUENCE_MAX_PAGES` and `NOTION_MAX_PAGES` set the page ceiling per source run** (default
  5000 each, as the built-in limit was; 1–100000). A source that reaches it stops there, logs a
  warning and writes `STOPPED AT THE N-PAGE CEILING (…_MAX_PAGES)` into the run's note, naming the
  setting to raise.
- **Text inside an inline SVG is indexed.** An HTML page's `<svg>` used to be dropped whole; its
  `<text>` (with `<tspan>`), `<title>` and `<desc>` now become paragraphs of the document, so a
  diagram's labels are searchable. Shapes, paths and styling are still dropped.
- **A scheduled source is never skipped for longer than `SYNC_MAX_SKIP_HOURS`** (default 24, `0`
  turns it off, at most 720; ADR-0095). The change check cannot see everything — a Notion page
  unshared from the integration keeps its edit time, a local file rewritten with its old modification
  time keeps the count and the newest time — so a due source whose last successful sync is older than
  this, or that never synced, is synced anyway, and that run removes what is gone. The price is one
  real sync per source per this many hours even when nothing changed. The log says
  `scheduled sync queued a run (max skip age)` when this is why a run happened. The dashboard's sync
  and webhook hints now say so instead of implying the interval alone catches an unshare.
- **`server.json` describes Contextator for the MCP Registry** (schema `2025-12-11`): one Streamable
  HTTP remote, `https://{host}/mcp/{project}`, whose `Authorization` header is needed only by a
  project in `token` mode. It is in the repository so a registry or a client can read it; it has not
  been published to the registry.
- **Static MCP tokens can expire.** `POST /api/projects/:id/mcp-tokens` takes an optional
  `expiresInDays` (`30`, `90` or `365`; any other value is a `400`) and
  defaults to `null`, a token that never expires — so a script that sends only `name` mints exactly
  what it did before, and so does a new project's first token. `GET /api/projects/:id/mcp-tokens`
  and the `token` of the `POST` answer now carry `expiresAt` (ISO 8601, or `null`). A token past its
  `expiresAt` is refused with `401` by a `token` or `account` project, like a revoked one; an expired
  token stays in the list until it is revoked. An `open` project still ignores the bearer it is given,
  expired or not (ADR-0054). No migration: `mcp_tokens.expires_at` already existed.
- **The dashboard sets and shows MCP token lifetimes.** The New MCP token dialog has an Expires
  choice — Never (the default), 30, 90 or 365 days. Each row of a project's token list shows
  "no expiry", the expiry date, or the time left once it is under two weeks; a token past its date
  is marked "expired" and stays listed until it is revoked. The "No token, no access" note of a
  `token` project now also appears when every token it has is expired.
- **The dashboard tells which projects still have a legacy SSE client.** A project whose
  `lastLegacySseAt` falls within the last seven days shows an informational note on its page, saying
  when a client last connected over legacy SSE and that the same URL takes Streamable HTTP. It gives
  no removal date, because none has been set (ADR-0096).
- **Helm chart 1.1.0 can render a Prometheus Operator `ServiceMonitor`.** Set
  `metrics.serviceMonitor.enabled` (off by default) to have `/metrics` scraped; `interval`,
  `scrapeTimeout`, `labels`, `annotations`, `honorLabels`, `relabelings` and `metricRelabelings` are
  passed through. The scraper's bearer credential is read from the same Secret entry as the Pod's
  `METRICS_TOKEN` (`envSecret.METRICS_TOKEN`). The chart README now covers the Kubernetes-specific
  parts of a backup and restore and points to the product README for the procedure itself.

### Changed

- **A web source asks for Markdown first for the pages a sitemap or `llms.txt` lists.** Those
  requests' `Accept` header ranks `text/markdown` above `text/html`, so a site that negotiates
  answers with the page's Markdown source, which is indexed as `.md` without an HTML conversion. The
  entry URL and every page a crawl visits still ask for HTML first, because the crawl reads its links
  from HTML and the entry's type decides the mode. On a negotiating site a listed page's path moves
  from `.html` to `.md` once: the next sync re-embeds those pages and `read_document` paths change.
  A server that answers a stored ETag with `304 Not Modified` keeps the old `.html` copy until the
  page changes. A site that does not negotiate serves HTML as before.
- **`EMBEDDING_BASE_URL`'s host is part of the model id** (`openai:<model>:<dims>@<host:port>…`), so
  pointing the provider at another server re-indexes every project, because two servers answering to
  the same model name are not guaranteed to produce the same vectors. Unset, or naming `api.openai.com`,
  the id is exactly what it was. `OPENAI_BASE_URL` never enters the id. Moving an existing setup from
  `OPENAI_BASE_URL` to `EMBEDDING_BASE_URL` — even with the same URL — is therefore an opt-in that
  re-indexes once: until a project's re-index finishes, its searches are refused with `model_mismatch`.
  A scheduled run whose content has not changed may wait up to `SYNC_MAX_SKIP_HOURS` (24 h by default;
  with `0`, or no schedule, until "Sync now"), so start a forced re-index of each project
  (`POST /api/projects/:id/reindex?force=true`) right after the switch.
- **`OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are no longer sent to a self-hosted endpoint.** The SDK
  read them from the process environment and sent them as `OpenAI-Organization` / `OpenAI-Project`
  headers to whatever server it was pointed at; they now reach `api.openai.com` only.
- **Every project shows its MCP access mode as a neutral badge** — `open`, `token` or `account` —
  in the project list and on the project page, the three alike in weight and colour. `open` carries
  no warning colour, icon or text (ADR-0065); the badge's tooltip states what a client has to send.
- **The dashboard's connection snippets lead with Streamable HTTP.** A new Streamable HTTP tab gives
  the URL (and the `Authorization` header for a `token` project) for any other MCP client; the
  Legacy SSE tab comes last and is labelled deprecated, for a client that cannot speak Streamable
  HTTP.

### Deprecated

- **The legacy HTTP+SSE MCP transport (protocol 2024-11-05) is deprecated** (ADR-0096). Every
  response of it — the `GET /mcp/:project` stream (and a `HEAD` of it) opened without an `mcp-session-id` and every answer
  of `POST /mcp/:project/messages`, refusals included — now carries `Deprecation: true`. No `Sunset`
  header is sent, because no date has been set: the transport behaves exactly as before, and it will
  not be removed before 1.0 nor sooner than twelve months from this release. Streamable HTTP answers
  carry neither header. CORS now exposes `Deprecation`, so a browser client on an `ALLOWED_ORIGINS`
  origin can read it too. Move clients to Streamable HTTP (`POST /mcp/:project`) at your own pace.
  To tell which projects still have such clients, `GET /api/projects` and
  `GET /api/projects/:id/status` now carry each project's `lastLegacySseAt` (ISO 8601, or `null` when
  no legacy client has reached it), updated at most once a minute; the dashboard shows a note on
  such a project's page. Migration `0019` adds the nullable `projects.last_legacy_sse_at` column;
  it is not carried by a project export.

### Fixed

- **The dashboard's Claude Desktop snippet works on Windows.** For a `token` project it passed
  `--header "Authorization: Bearer …"` to `mcp-remote` as one argument with spaces, which Windows
  splits, so the server answered 401. It now passes `Authorization:${AUTH_HEADER}` and sets
  `AUTH_HEADER` in the server's `env`, the form the documentation already uses.
- **The OAuth authorization page no longer tells a stranger who belongs to a project.** A signed-in
  account without access to the project is now refused on the consent page itself (`403`) instead of
  being redirected, so a self-registered client cannot use the redirect to learn whether a given
  person is a member; refusing on the consent form still redirects with `access_denied`.
- **Exchanging an authorization code for a project deleted in the meantime answers `invalid_grant`**
  instead of `500`, and a token refresh racing a project deletion no longer deadlocks. A project can no
  longer be deleted in the moment between its busy check and the delete.
- **The query-log panel no longer shows an older answer as the current one.** When the floor preview
  was asked again before the previous answer arrived, the late answer could replace the newer one; it
  is now matched to the latest request and stale data is marked as such.
- **A Notion source no longer overshoots its page ceiling.** The limit was checked only after a
  whole search batch had been taken, so a source could pull up to one batch more than the ceiling;
  it is now applied page by page, and a source that fills the ceiling exactly is not reported as cut.
- **A run cut short by a restart no longer leaves its project stuck in `indexing`.** On startup every
  project the previous process left indexing gets an `interrupted` row in its run history, leaves the
  `indexing` state — which was blocking source edits and deletion — and an **incremental** run is
  queued for it in the background lane, whatever the lost run was: if it was a forced re-index,
  force it again. The dashboard's history shows the row as interrupted. A project whose recovery
  fails is logged and does not stop the others from being recovered.

### Upgrade notes

- **No full re-index is needed.** Migration `0019` adds one nullable column and runs at startup.
  An installation that sets `OPENAI_BASE_URL` keeps its model id; only moving to
  `EMBEDDING_BASE_URL` re-indexes, and only once (see Changed).
- **On a web source whose site negotiates Markdown, listed pages are re-embedded once.** Their next
  sync stores them as `.md` instead of `.html`, so a `read_document` path saved before the upgrade
  stops resolving (see Changed). With `SYNC_MAX_SKIP_HOURS` at its default this happens within a day.
- **Expect one real sync per scheduled source shortly after the upgrade.** A source whose last
  successful sync is older than `SYNC_MAX_SKIP_HOURS` runs at its next due time even if its check
  says unchanged. Set `SYNC_MAX_SKIP_HOURS=0` to keep the old behaviour.
- **Existing MCP tokens do not expire.** Only a token created with a lifetime does.

## [0.2.0] - 2026-09-25

### Added

- **`npm run backup` and `npm run restore`: one archive that is the installation, not just the
  database.** `docker exec contextator npm run backup -- /data/backups/instance.tar.gz` writes the
  database dump, the materialised files of every **upload** source — which exist nowhere else — and a
  manifest that is read before anything else. Restoring is the same command backwards, and
  `--check` evaluates every refusal and writes nothing. The `pg_dump` and `pg_restore` lines you have
  been running by hand still work and are still what the test suite asserts on; what they never
  carried was the other half.
- **`SECRET_KEY` is never written into a backup, and a restore refuses the wrong one before it writes
  anything.** The archive records a fingerprint of the key, not the key: enough for `restore` to stop
  with a message naming the key it wants, and nothing like enough to be the key. Previously a restore
  with a different key succeeded and left every stored source credential undecryptable — discovered
  later, one source at a time. Keep the key where the archive is not.
- **A procedure for upgrading the embedded PostgreSQL across a major version**, in OPERATIONS.md §3.2,
  executed 16 → 17 before it was written: back up, start the new image against an *empty* cluster
  volume, restore, keep the old volume as the rollback. `pg_upgrade` needs both majors' binaries at
  once and the image carries one. Pulling an image whose PostgreSQL crossed a major without doing this
  gives `FATAL: database files are incompatible with server` and a restart loop — nothing is damaged,
  and rolling the tag back is the way out.

- **You can point Contextator at a PostgreSQL you already run.** Put a `DATABASE_URL` in `.env` and
  the container starts no database of its own: it connects to the server you named, creates and
  migrates its schema there, and leaves the `contextator-pgdata` volume empty. The server needs to be
  PostgreSQL 16 or newer with pgvector installed or installable by that role. **On this topology its
  backups are yours** — `docker exec contextator pg_dump …` dumps the embedded database and reaches
  nothing else.
- **A `-slim` image, for the same thing without a PostgreSQL inside it at all.** Every published tag
  from this release on has a `-slim` twin — `latest-slim`, `0.2-slim`, `0.2.0-slim` — carrying the
  application alone, on both architectures. It requires `DATABASE_URL` rather than accepting it, and started without one
  it exits immediately naming the variable and what the server behind it has to be.
  `docker-compose.slim.yml` runs it. The default image and the default installation are unchanged: a
  single container with its own PostgreSQL is still what `docker compose up -d` gives you.
- `/api/health` tells a signed-in caller which of the two databases it is talking to
  (`database.mode`), and an administrator the host, port and database name — never the credential.
- A source's **Language** setting is back on the dashboard, and `turkish` is one of the values it
  offers. Naming a source's language makes PostgreSQL stem it, so a Turkish question asking about
  `anahtarı` now finds a page that says `anahtarın`. Changing the setting re-indexes that source, as
  changing its content type already did.

- **A published documentation site is a source type.** Point a **Documentation site** source at a
  `sitemap.xml`, an `llms.txt` or one start URL, and it reads public pages over HTTP — staying on that
  host and under that path when it crawls. It refuses an entry point it cannot recognise rather than
  guessing, stores no credential at all, and stops at five ceilings (`WEB_MAX_PAGES`, `WEB_MAX_DEPTH`,
  `WEB_REQUEST_DELAY_MS`, `WEB_CRAWL_BUDGET_MS`, `WEB_RESPECT_ROBOTS`) that say which one ended a run.
- **Confluence Data Center 7.9 and later**, beside Cloud. Pick the *Deployment* when adding the source:
  Data Center takes a base URL with its context path and a personal access token. Its version is read
  before any credential is sent, and an older release or a server that is not Confluence is refused by
  name. Confluence Server is not supported.
- **A signed Confluence Data Center webhook**, off until an editor turns it on per source:
  `POST /api/webhooks/confluence/<source-id>` queues a sync through the same debounce as the git
  webhooks. Confluence Cloud cannot send these, so there the sync interval stays the only trigger.
- **Sign in through an OIDC identity provider.** `OIDC_ISSUER_URL` adds an SSO button beside the
  password form, which never goes away. By default SSO signs in accounts an admin already created;
  `OIDC_AUTO_PROVISION=1` lets a first sign-in create one with `OIDC_DEFAULT_ROLE`, which is never
  `root`.
- **Per-account API tokens.** Any account can mint one from its menu, restricted to a project, an
  expiry date and an exact list of routes, and revoke it on its own. A token never does more than the
  account behind it, and the audit log names the token that acted. It is now the recommended
  credential for scripts instead of `ADMIN_TOKEN`, which is unchanged.
- **`SECRET_KEY` can be rotated.** Set the old key as `SECRET_KEY_PREVIOUS` and the new one as
  `SECRET_KEY`, restart, run `npm run rotate-secret`, then remove `SECRET_KEY_PREVIOUS`. Reads fall back
  to the previous key while it is set; every write uses the new one.
- **A project can set its own relevance floor**, or turn it off, from its query-log panel, which shows
  what the new floor would have done to the searches already logged before it is applied.
  `SEARCH_SCORE_FLOOR=0` still turns every project's floor off.
- **Indexed documents are MCP resources** (`contextator://<project>/<source>/<path>`), listed and read
  behind the same auth as the tools and never beyond what `read_document` reaches.
- **`MCP_STRUCTURED_OUTPUT=1` adds structured JSON to every tool answer** — an `outputSchema` and
  `structuredContent` beside the text, which stays exactly the same. It is off by default, because
  Claude Code reads the structured part instead of the text when both are present.
- **A Helm chart, `charts/contextator/` (chart version 1.0.0)**, for the `-slim` image against an
  external database, published to `https://contextator.github.io/Contextator` by every release. It
  runs exactly one Pod, and its values schema is strict: a misspelt key fails `helm install` by name.
- `GET /api/audit` takes `actorUser`, which finds an account's own events and those of every API token
  it owns; the dashboard's audit view gains an account picker.

### Changed

- **`.env.example` now ships `DATABASE_URL` empty, and this is the one thing to check before you
  upgrade.** The container reads that line where it used to clear it. A `.env` copied from the old
  template carries `postgres://contextator:contextator@localhost:5432/contextator` for `npm run dev`
  — and after this release that line tells the container *not* to start its own PostgreSQL and to
  connect to its own loopback instead, where nothing is listening. **Clear `DATABASE_URL` in `.env`
  before `docker compose up -d`**, unless you are deliberately naming an external database. The
  container says so in its log if you forget: the startup line names the database it chose, and a
  loopback address on an image that embeds one is called out by name. Running from a source checkout
  with `npm run dev`, put the value back — it is the only way to say where the database is there.
- **A new project's MCP endpoint requires a token.** Creating a project now mints that project's
  first token and shows it once, in the creation dialog; before this, a new project was `open` and
  answered anyone who could reach its URL. Make it **open** from the project page if its documents
  should be readable without a credential — the mode is unchanged and is still there.
- **`docker compose` publishes the port on `127.0.0.1` instead of on every interface.** A default
  installation is now reachable from the machine it runs on and from nowhere else. Set
  `CONTEXTATOR_BIND=0.0.0.0` in `.env` to publish it on the network as before, and put a
  TLS-terminating reverse proxy or a VPN in front of it when you do. `HOST` inside the container is
  unchanged at `0.0.0.0`; what moved is which host interface Docker publishes to.
- **Keyword search now speaks every language in a project at once.** It used to parse every question
  in one configuration chosen for the whole instance, which meant a source that named a language was
  indexed one way and asked another, and contributed nothing to the keyword half at all. Each source
  is now read in its own configuration and one search reaches all of them. A project that names no
  language on any source is unaffected, down to the ordering of its results.
- **Every project has its own partial HNSW index**, built with `CREATE INDEX CONCURRENTLY` when the
  project is created. A search now scans its own project's rows instead of every chunk in the instance,
  so `HNSW_MAX_SCAN_TUPLES` is counted per project. The first start after upgrading builds one index
  per existing project.
- **Where a Confluence source may connect is bounded** (ADR-0088). Loopback, link-local — the cloud
  metadata address included — unspecified and multicast addresses are always refused; a private
  address is reached only when its host is listed in `CONFLUENCE_ALLOWED_HOSTS`. The check runs on the
  connected address, after DNS and on every redirect.
- **Unlinking an SSO identity revokes that account's MCP OAuth tokens** in the same transaction, as it
  already invalidated its sessions and API tokens.
- **A secret on a `local`, `upload` or `web` source is refused** with `400 invalid_request` naming the
  type, instead of being stored and never used. `secret: null` is accepted on every type.
- Files are converted on a worker thread. A file that takes seconds to parse no longer blocks search,
  and one that exhausts its thread or runs past `CONVERSION_TIMEOUT_MS` is refused by name while the
  run carries on.
- Document text in MCP tool answers is fenced, and the fence widens rather than escaping the document,
  so a page cannot pass itself off as the tool's own words.

### Fixed

- **Operator commands run inside the container could not find the database.**
  `docker exec contextator npm run reset-password -- <username>` — the documented last resort when
  nobody can sign in — stopped at `Invalid configuration: Set DATABASE_URL, or the libpq variables
  PGHOST/PGUSER/PGPASSWORD/PGDATABASE` on every installation using the container's own PostgreSQL.
  The entrypoint sets those variables for the one process it starts, and `docker exec` does not see
  that process's environment. CI had been asserting that the command prints its usage line, which it
  reaches three lines earlier. It now works, and CI talks to the database.

- **The same search over the same documentation returns the same page again.** Between two results
  that scored identically, which one came first was decided by an internal identifier that is minted
  fresh every time a project is re-indexed — so a project holding two languages could hand back a
  different fifth result after a rebuild, with nothing having changed but the rebuild. Equal results
  are now ordered by the documents themselves: the shorter excerpt first, then the document's own
  path and the position of the passage within it.
- **Revoking an account's MCP credentials could miss a sign-in already in flight.** An SSO unlink, a
  password change or an administrator's reset did not reach an authorization code approved in the
  minute before it, and a refresh rotation racing the revoke could mint a pair it never saw. The
  exchange now re-checks the account, its access to the project and a revoke counter under the account
  row's lock, and refuses a stale code with `invalid_grant`.
- Documentation said PostgreSQL has no Turkish configuration. It has one, and Turkish sources were
  being indexed without stemming because of that claim.

### Upgrade notes

- **No existing project changes.** The migration moves the column's default and rewrites no row: a
  project configured `open` stays `open` after the upgrade, and every agent already configured
  against it keeps working. What is different is the next project you create — it is born requiring
  a token, and hands you that token as it is created.
- **The published port moves on your next `docker compose up -d`.** If you reach this instance from
  another machine — a colleague's laptop, an agent running elsewhere, a proxy on another host — set
  `CONTEXTATOR_BIND=0.0.0.0` in `.env` before restarting, or it will stop answering them. Reaching
  it from the host it runs on needs nothing.
- **Nothing is re-indexed for the keyword change.** The first start after upgrading rewrites the
  keyword index of any source that names a language, in batches, from text already in the database —
  no re-embedding and no rebuild. Searches keep working while it runs.

## [0.1.0] - 2026-09-19

First published release. `0.1.0` describes what the product does, not what changed to get there.

### Added

- A self-hosted, multi-tenant MCP documentation server: give a project its document sources and it
  becomes its own `/mcp/<project-name>` endpoint that AI agents can search.
- Source types: local directories, git repositories, uploaded files and archives (`.zip`, `.tar`,
  `.tar.gz`, `.rar`), Notion workspaces and Confluence Cloud sites.
- Document conversion to Markdown for `.html`, `.docx`, `.csv` and `.pdf` files, so an agent reads
  them the way it reads a page of documentation.
- An OpenAPI/Swagger content type: a specification is indexed as one document per operation, not
  as a single file, so a hit is the endpoint rather than the whole spec.
- Hybrid search: vector similarity and keyword search fused with reciprocal rank fusion, over
  chunks that carry a heading breadcrumb.
- Local embeddings on the CPU by default (`multilingual-e5-small`, covering 100 languages), with
  `EMBEDDING_DTYPE` to trade model size against precision (fp32/fp16/q8), or OpenAI embeddings as
  an alternative. Search within a language is strong; cross-language search is a known limit and
  is documented as one in the README rather than fixed.
- An admin dashboard and REST API to manage projects, sources and members — the normal way to add
  a source and trigger a re-index.
- MCP access on one URL per project, both transports: Streamable HTTP and legacy HTTP+SSE. Tools:
  `search_docs`, `list_topics`, `read_document`.
- Three settings for an MCP endpoint: open, a static bearer token, or account-backed access through
  OAuth 2.1 — the last so browser-based connectors can sign in.
- Accounts, roles and per-project memberships, with `ADMIN_TOKEN` for scripts and CI.
- An audit log and a per-query log of what agents asked and what they were told.
- Incremental indexing: files are hashed, only changed files are re-embedded, removed files are
  deleted from the index.
- One Docker image, `contextator/contextator`, for `linux/amd64` and `linux/arm64`, holding both
  PostgreSQL and the app. The schema updates itself on startup, and `npm run reset-password` ships
  inside the image as a last-resort recovery tool.

[Unreleased]: https://github.com/Contextator/Contextator/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Contextator/Contextator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Contextator/Contextator/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/Contextator/Contextator/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Contextator/Contextator/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Contextator/Contextator/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Contextator/Contextator/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Contextator/Contextator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Contextator/Contextator/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Contextator/Contextator/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Contextator/Contextator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Contextator/Contextator/releases/tag/v0.1.0
