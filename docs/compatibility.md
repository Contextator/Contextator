# Compatibility policy

This is what a Contextator release promises not to break. It holds from `1.0.0` on, and it is the one place the
promise is written down: the changelog, the README, the security policy and the documentation site link here and do
not restate it.

The promise is made in terms of [Semantic Versioning](https://semver.org/). A patch release changes no contract. A
minor release only adds. Apart from the two [exceptions](#exceptions) below, a major release is the only one that
may remove or change what this page lists, and it comes no sooner than six months after the release that announced the
removal.

## The three tiers

Not everything is promised the same way, because the people who depend on each thing are different.

### Tier 1: the application's version

Everything below is frozen under the application's own SemVer.

- **MCP.** Tool names, input schemas, `outputSchema` fields and annotations; prompt names and arguments; the resource
  URI scheme and template; the transport URLs; both protocol eras (the 2025 one included; the legacy HTTP+SSE
  transport is the exception, see [Legacy HTTP+SSE](#legacy-httpsse)).
- **OAuth.** The endpoints.
- **Admin API.** Routes, methods, the access each route requires, `error` codes, status codes and response fields;
  webhook endpoints; the `/api/health` fields.
- **Configuration.** Server environment variable names, the values they accept and their default behaviour; the
  `BACKUP_*` variables (`BACKUP_STAGING_DIR` included); the CLI's `CONTEXTATOR_URL` and `CONTEXTATOR_TOKEN`.
- **CLI.** Commands, flags, exit codes and `--json` keys.
- **Data.** Forward-only migrations, backup archives and export archives (see [Upgrading](#upgrading)).
- **Packaging.** The container port, `/data`, and the image tag scheme. The `1` and `1-slim` tags follow the newest
  `1.x` release.
- **Runtime floors.** The PostgreSQL major embedded in the `full` image, and the external database floor
  (PostgreSQL 16 or newer). Both change only in a major release. The reason is that a changed embedded major stops a
  pulled image from opening its own data. The Node.js floor is not in this list, see
  [The Node.js floor](#the-nodejs-floor).

### Tier 2: versioned on their own

- **Helm values** follow the chart's own SemVer. Removing, renaming or narrowing a key is a chart major. The chart is
  versioned separately from the application, so a chart major does not need an application major.
- **`manifestVersion`** in the backup and export archives is the archive format's own number.
- **Prometheus metrics.** Metric families and labels may be added at any time. One is removed or renamed only in an
  application major.

### Tier 3: not a contract

Tool description and title text, and the text output of a tool beyond what the API reference already requires of the
first line of a hit; the dashboard; log lines; `public/product-facts.json`; the `EVAL_*` and smoke-test variables;
audit event detail text; and one variable the image's entrypoint sets for the application's own use, which is internal
and not documented. The other variables the entrypoint passes along, the `PG*` connection variables included, are
Tier 1.

These can change in any release. Reworded descriptions in particular are tuned for agents and are left out of the
contract on purpose.

## What counts as breaking

For anything in Tier 1, these are breaking and ship in a major release only:

- removing or renaming anything listed above;
- narrowing a type or an accepted value;
- a new required argument, field or variable;
- changing a default behaviour;
- tightening the access a route requires;
- a value that used to start the server making it refuse to start.

These are not breaking:

- a new optional argument whose default is the old behaviour;
- a new field, route, tool, variable, command or flag (these ship in a minor release);
- a fix that changes no contract (a patch release).

Each Tier 1 and Tier 2 surface is held by a snapshot test in the repository, and a pull request that changes one has to
add a line to the changelog. Whether a change is an addition or a break is judged in review. A break is labelled
**BREAKING** in the changelog and waits for a major.

## Deprecation

Anything that is going to be removed is announced first, in at least one minor release:

1. a `Deprecated` entry in [`CHANGELOG.md`](../CHANGELOG.md);
2. a warning at startup, or a `Deprecation` header, wherever the surface has one;
3. a note in the documentation.

The major release that removes it ships no sooner than six months after the release that announced it.

## Exceptions

There are exactly two, and both are named so they are not a surprise.

### Legacy HTTP+SSE

The legacy HTTP+SSE transport (protocol revision 2024-11-05) is **deprecated, not frozen**. It has been deprecated
since `0.2.1` (2026-10-02). It is outside the freeze: it may be removed in a minor release.

- **Sunset date: 2027-10-02.** The transport may be removed in the first `1.x` minor release after that date.
- **Security exception.** If a vulnerability in the legacy transport path cannot be fixed, the transport may be
  removed before that date.
- **How it announces itself.** Every response of the transport (the session-less `GET /mcp/<project>` stream, its
  `HEAD`, and every answer of `POST /mcp/<project>/messages`, refusals included) carries
  `Deprecation: @1790899200` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html)),
  `Sunset: Sat, 02 Oct 2027 00:00:00 GMT` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594.html)) and a `Link`
  header with `rel="deprecation"` and `rel="sunset"` that points at this section. Streamable HTTP responses carry
  none of them.
- **What to do.** Point the client at the Streamable HTTP endpoint. A project's page in the dashboard shows a note when
  a legacy SSE client reached it in the last seven days.

A server that nobody upgrades keeps answering over SSE; the date binds releases, not installed servers.

### The Node.js floor

The `engines.node` floor (Node.js 24 as of `1.0.0`) may rise in a minor release. It rises only to an active LTS line,
it is announced as `Deprecated` in the minor release before, and it happens only when both container images already run
that line. Someone who runs the published images is therefore not affected; the people it concerns are those who run
the server from source.

## Upgrading

- **Every `1.x` upgrades every earlier `1.x`.** The migrations are forward-only and each release applies the ones it
  lacks at startup, so a database can skip releases.
- **Archives.** Every `1.x` reads backup and export archives produced by `0.7.0` and later, and by any `1.x`.
- **Downgrading is not supported.** To go back, restore a backup taken before the upgrade.
- **Moving from `0.7.x` to `1.0.0`.** Read the `1.0.0` entries in the changelog first. Among the changes there:
  `CONFLUENCE_ALLOWED_HOSTS` is refused at startup (move its hosts to `SOURCE_ALLOWED_HOSTS`), and the Helm chart is
  `3.0.0`, which drops `config.confluenceAllowedHosts`. Running from source needs Node.js 24, and the legacy SSE
  `Deprecation` header changes from `true` to a date.

## Support window

Security fixes land on the **latest release only**. There is no long-term support line and no maintenance branch for
an earlier major version. See [`SECURITY.md`](../SECURITY.md).

## What is deprecated now

| What | Announced in | Earliest removal |
|------|--------------|------------------|
| Legacy HTTP+SSE transport | `0.2.1` | The first `1.x` minor release after 2027-10-02 (earlier only for an unfixable vulnerability in it) |
| `OPENAI_BASE_URL` | `1.0.0` | `2.0`. It is still read when `EMBEDDING_BASE_URL` is empty and logs a warning at startup. Use `EMBEDDING_BASE_URL`. |

Removed at `1.0.0`, for the record: `CONFLUENCE_ALLOWED_HOSTS` (deprecated in `0.6.0`). A non-empty value stops the
server from starting, with a message that names `SOURCE_ALLOWED_HOSTS`. See
[Egress allowlists](configuration.md#egress-allowlists-which-private-hosts-a-source-may-reach).

## Documentation versions

The documentation is one current set. A page that describes something a later `1.x` minor adds says `since 1.x`, with
the version. A separate archive of the `1.x` documentation is opened only when `2.0` ships.
