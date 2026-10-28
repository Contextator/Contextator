# Document sources

A project is a set of **sources**. Each one is added in the dashboard (**Add source**), carries a
URL-safe `name`, and that name becomes the prefix of every document it contributes: a file
`install.md` in a source named `handbook` is indexed, searched and read as `handbook/install.md`.
The name is the mount point, so it cannot change after creation; everything else can.

| Type | What it is | Synced by |
|------|-----------|-----------|
| **Local directory** | A folder mounted on the server, scanned in place. Must live inside `ALLOWED_DOC_ROOTS`; nothing is copied. | Reading it at index time |
| **Git repository** | A shallow, single-branch checkout under `DATA_DIR`. Any HTTPS git server: GitHub, GitLab, Bitbucket, Gitea/Forgejo/Codeberg. Optionally only a **subdirectory** of the repository (`docs/`). | `git fetch` of the branch tip at the start of every index run, a push webhook, or the sync interval below |
| **Upload** | Files, whole folders (structure preserved) and archives — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.rar` — unpacked on the server. Add to the existing files or replace them all. | Nothing to sync; the files live under `DATA_DIR` |
| **Notion** | Every page shared with an internal integration (or the configured root pages/databases and their descendants), rendered to Markdown, nested by parent page. | The Notion API, re-rendering only pages whose `last_edited_time` changed |
| **Confluence** | **Cloud, or Data Center 7.9 and later** (see below). Every page in the chosen spaces — or in every space the account can read — rendered from Confluence's storage format to Markdown, nested the way it is in the wiki: `<name>/<space>/<parent page>/<page>.md`. | The Confluence REST API, re-rendering only pages whose version number changed; a signed webhook on Data Center, or the sync interval below |
| **Documentation site** | **Public pages only** (see below). A published site, found through its `sitemap.xml`, its `llms.txt` or a crawl from one start URL, written under the site's own paths: `<name>/guide/install.html`, converted to Markdown by the same transform `.html` files use. | Conditional GETs against the site (`ETag`/`Last-Modified`), inside the five crawl ceilings below |
| **S3 bucket** | The objects under one prefix of an S3-compatible bucket (AWS S3, MinIO, Ceph, Cloudflare R2…) whose file type the source reads, written under the prefix-relative key: `<name>/guides/install.md`. A key pair is stored encrypted (see below). | `ListObjectsV2`, downloading only objects whose ETag or size changed; the sync interval below |

Sources are synced at the start of every index run, one after another; a source that fails to sync is
reported on its own row and the others still index. **Sync** on a row and **Re-index** in the header
both queue the same run.

## Versions: two releases of one product in one project

A source can carry a **version** — the *Version* field in its dialog — and every document it indexes is
stamped with it. An agent then narrows a search to one release:

```text
search_docs(query: "rotate the signing key", version: "v3")
```

Omit it and the search reaches every version, which is what it did before the field existed and what a
project with one release wants. The point is the project that has two: index v2 and v3 of a product side
by side and an agent asked about "the timeout setting" will otherwise answer confidently out of
whichever page ranked higher.

**It is a free-text label, matched exactly, and there is no "latest".** `v3`, `2024.1`, `next` and
`legacy` are all things a documentation team writes, and a product that claimed to order them would be
confidently wrong about at least one — which is the failure this feature exists to stop. An agent that
asks for a version this project does not have is told so, with the versions it *does* have, and picks
one.

**Several sources may share a version**, which is the reason this is not the `source` filter under
another name: `api-v3` and `sdk-v3` are two mount points of one release, and `version: "v3"` searches
both. Changing a source's version re-indexes it, the way changing its content type does.

## Confluence: Cloud or Data Center

Cloud (API token) and Data Center (personal access token) authenticate differently, so **Deployment** is
picked by hand, not detected. Data Center connections to a private address are refused unless the host is
listed in `SOURCE_ALLOWED_HOSTS` (the older `CONFLUENCE_ALLOWED_HOSTS` still works, with a startup warning; see [Configuration](configuration.md#egress-allowlists-which-private-hosts-a-source-may-reach)), one source indexes at most 5 000 pages, and a named
space that stops answering fails the sync rather than deleting its documents. On Data Center a signed
webhook can start a sync as soon as a page changes.

Full setup for both deployments, the SSRF boundary, space scoping and the webhook: [Confluence](https://contextator.com/en/docs/confluence/).

## Documentation sites: public pages, and five ceilings

A **Documentation site** source reads a public site's own `sitemap.xml` or `llms.txt`, or crawls it from
one start URL — no login, no credential stored, no headless browser. Five instance-wide ceilings
(`WEB_MAX_PAGES`, `WEB_MAX_DEPTH`, `WEB_REQUEST_DELAY_MS`, `WEB_CRAWL_BUDGET_MS`, `WEB_RESPECT_ROBOTS`)
bound a crawl and stop it by name rather than failing the run; only a `sitemap.xml` source gets a cheap
freshness check, `llms.txt` and crawl sources re-fetch in full on every scheduled run.

Field-by-field setup, the five ceilings table, `robots.txt` handling and common problems: [Documentation Site Source](https://contextator.com/en/docs/documentation-site-source/).

## S3 buckets: a prefix, a key pair, and a listing per check

An **S3 bucket** source mirrors the objects under one **prefix** whose extension the source reads (the **File
types** ticked in the dialog; `.md`, `.mdx` and `.txt` by default) to `DATA_DIR` and indexes them like any
other directory. The prefix is removed from the names: with prefix `guides`, the object `guides/nested/a.md`
in a source named `handbook` is `handbook/nested/a.md`. Folder markers (keys ending `/`), names starting with
a dot and keys that could leave the source's directory (an empty, `.` or `..` segment) are skipped, and the
run's note counts the ones that matter.

- **Endpoint and addressing.** Leave **Endpoint** empty for AWS S3 (`https` only, region from **Region**). For
  MinIO, Ceph, R2 or another S3-compatible server give its address; `http` and `https` are both allowed there.
  Addressing is path-style (`host/bucket/key`) when an endpoint is given, and on AWS when the bucket name has a
  dot; otherwise virtual-hosted (`bucket.host/key`). The **Addressing** field overrides it either way.
- **The key pair** is one credential: an access key ID and a secret access key, stored encrypted with
  `SECRET_KEY` as a single document and never returned by the API or shown again. Over the API the `secret` is the
  JSON string `{"v":1,"accessKeyId":"…","secretAccessKey":"…"}`. **Temporary credentials (a session token) are not
  accepted** — a stored credential that expires in hours would fail a scheduled source a day later — and neither
  are instance-profile or IRSA credentials, which come from the metadata address the egress guard always refuses.
  Grant the key `s3:ListBucket` on the bucket and `s3:GetObject` on the prefix, and nothing else.
- **A private endpoint** (a MinIO inside the network) is refused unless its host name is listed in
  `SOURCE_ALLOWED_HOSTS`; the refusal names the rule, the host and that setting. Loopback and link-local are
  refused whatever is listed. With virtual-hosted addressing the host that resolves is `<bucket>.<endpoint host>`,
  so list that name (or use path-style). An S3 interface VPC endpoint with private DNS resolves
  `s3.<region>.amazonaws.com` to a private address; list that name.
- **What a check costs.** Every scheduled check lists the whole prefix (`ListObjectsV2`, 1 000 keys a request) and
  downloads nothing; the source runs only when the listing changed. On a prefix with many keys outside the
  source's scope the check still lists them all, so give the source the narrowest prefix and file types that
  hold its documents — the run's note shows how many keys were listed.
- **Bounds.** One source indexes at most `S3_MAX_OBJECTS` objects (5 000 by default, see
  [Configuration](configuration.md#object-ceiling-for-s3-sources)): the first ones in key order, and the run's note
  says in capitals that the rest are not indexed. An object over `MAX_CONVERTED_FILE_BYTES` is refused by name and
  not downloaded, and a run that would leave less than `DATA_DIR_MIN_FREE_BYTES` free fails with
  `insufficient_disk` before it downloads anything.
- **Failures.** A network error or a `5xx` answer (`503 SlowDown` included) is tried three times; a `4xx` answer
  fails the run at once with S3's own error code (`AccessDenied`, `NoSuchBucket`, `SignatureDoesNotMatch`). Every
  `503 SlowDown` is counted in `contextator_source_throttled_total{source_type="s3"}` (see
  [Observability](observability.md#source-throttling)), retried or not. A failed run does not move the manifest or the
  freshness check, so the next check runs it again; files the run had already replaced keep their new content, and
  nothing is deleted until every download has succeeded. A listing page larger than 8 MiB is refused rather than read.
- **Export and import.** A project export carries the source's settings and not its key pair; an imported S3
  source arrives unscheduled and needs its credential entered again.

## Keeping a source fresh on its own

A source can carry a **sync interval** — the *Sync every* field in its dialog — and the server checks it
on that schedule instead of waiting for somebody to press a button.

**It does not re-read the files to decide.** Each source type answers one cheap question first, and the
index run only happens when the answer moved since the last successful sync:

| Type | What is asked | Instead of |
|------|---------------|-----------|
| Git | `git ls-remote` on the tracked branch — one ref advertisement, no objects | A fetch |
| Notion | One `search`, newest edit first, one result | A page read per page, 350 ms apart |
| Confluence | One CQL search over the same spaces the run indexes: how many pages there are, and when the newest was touched | A listing plus a body read per page |
| Documentation site | Two requests — `robots.txt`, then the `sitemap.xml`: how many URLs it lists, and the newest `<lastmod>` among them | A conditional GET per page |
| Local, Upload | The file count and the newest modification time | Reading and hashing every file |

A check that cannot answer — a directory that has gone, a rate-limited API, a network that is down —
counts as *changed*, so the run happens and reports the real error. The check is an optimisation; it is
never a reason a source silently stops syncing.

**An unchanged answer can only skip so long.** Some changes move nothing the check looks at — a Notion
page *unshared* from the integration keeps its edit time, a local file rewritten with its old
modification time keeps the count and the maximum. So a due source whose last successful sync is older
than `SYNC_MAX_SKIP_HOURS` (24 by default; `0` switches this off) is synced anyway, and that run removes
whatever is no longer there. An unshared page therefore leaves search within about a day plus one
interval — or at once, with *Sync now*. The log says `scheduled sync queued a run (max skip age)` when
this is why a run happened.

Two things about the timing are deliberate. A source that is switched on is given a **random** first
due time inside its first interval, so a hundred sources added by one script do not all wake in the
same minute — and keep not waking together afterwards. And scheduled runs queue **behind** anything a
person or a webhook asked for, so pressing *Re-index* never means waiting for the timer's backlog.

**Upgrading an existing installation switches nothing on.** Every source that already existed stays at
*Never*; only sources created afterwards take `SYNC_DEFAULT_INTERVAL_MINUTES` (an hour by default, and
`0` means new sources are unscheduled too). If this server should never make an outbound call nobody
asked for, it does not have to be turned off — it was never on.

## Content types (flavors)

A source can declare what its files really are, which applies a small transform before chunking: plain
Markdown/text (no transform), Obsidian vault (see below), Notion export (strips the page id Notion
appends to names and links), or OpenAPI/Swagger (see below — the one content type that turns a
specification into **one document per endpoint**). Changing a source's content type drops its stored
file hashes and queues a full re-index, because the transform runs after the hash that decides what to
re-embed.

Full comparison table and the Notion-export id-stripping example: [Content Types](https://contextator.com/en/docs/content-types/).

## OpenAPI and Swagger

An API specification is the most useful single thing you can give an agent about an API, and the least
useful shape to give it in: one `openapi.yaml` is one document that contains the answer to three hundred
different questions, so it matches every query and answers none of them.

With the **OpenAPI / Swagger** content type a specification is indexed as **one document per
operation** — path, method, summary, parameters, request and response schemas and examples, each under
its own heading so a hit carries a breadcrumb like `GET /pets/{petId} > Responses > 200`. `search_docs`
returns the endpoint, not the file. Both OpenAPI 3 and Swagger 2.0 are read, a specification is measured
against `MAX_SPEC_FILE_BYTES` (8 MiB, roughly 400 MB of parsed heap at the default) before it is read, and
one rendered document is capped at 2 000 lines, one specification at 5 000 operations.

Full behaviour — path derivation, `$ref` resolution depth, malformed-file handling, versioning per
specification: [Content Types](https://contextator.com/en/docs/content-types/#openapi--swagger).

## Obsidian vaults

A vault — mounted on the server as a **Local directory** with content type *Obsidian vault*, or uploaded
as a folder or zip through the **Obsidian vault** tab — has its own syntax flattened so an agent reads
plain Markdown: `[[wikilinks]]`, block references, image embeds, callouts and `%% comments %%` are all
converted; `.obsidian/` and other dot-directories are skipped.

Full conversion table and frontmatter handling: [Obsidian Vaults](https://contextator.com/en/docs/obsidian-vaults/).

## Notion

An **internal integration** (token from `notion.so/profile/integrations`, shared with the pages or
databases you want indexed) turns each page into one Markdown file, nested by parent page, re-rendered
only when its `last_edited_time` moves. A rejected token or an unreadable root fails the source with that
message rather than reporting an empty workspace — which would otherwise delete every page already
imported.

Full setup steps, the rendered-block list and rate limiting: [Notion](https://contextator.com/en/docs/notion/).

## Private repositories and tokens

An access token pasted into a git source's **Access token** field is encrypted with `SECRET_KEY`
(AES-256-GCM), never returned by the API or shown again. The username sent with it is detected from the
provider (`x-access-token` for GitHub, `oauth2` for GitLab, `x-token-auth` for Bitbucket Cloud) unless you
type one in the **Username** field. **Git is read over HTTPS only** — SSH remotes are not supported and no
SSH key can be stored; a repository reachable only over SSH is mirrored yourself and added as a
**Local directory** source instead.

Provider-by-provider token scopes and usernames, the SSH-mirror workaround, common `Test connection`
errors: [Git Repository Source](https://contextator.com/en/docs/git-repository-source/).

## Push webhooks

Every git source gets a webhook URL and a shared secret (shown while editing the source):

```text
POST http://<your-host>/api/webhooks/git/<source-id>
```

Add it as a **push** webhook in the repository settings with that secret; GitHub, GitLab, Gitea/Forgejo
and Bitbucket are all recognised and signature-verified before anything is queued. A Confluence Data
Center source has its own webhook, off by default and turned on from the source's edit dialog.

Full provider-by-provider field screenshots, the Confluence webhook walkthrough and troubleshooting:
[Push Webhooks](https://contextator.com/en/docs/push-webhooks/).
