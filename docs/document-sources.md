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
| **Notion** | Every page shared with an internal integration or an OAuth connection (or the configured root pages/databases and their descendants), rendered to Markdown, nested by parent page. | The Notion API, re-rendering only pages whose `last_edited_time` changed |
| **Confluence** | **Cloud, or Data Center 7.9 and later** (see below). Every page in the chosen spaces — or in every space the account can read — rendered from Confluence's storage format to Markdown, nested the way it is in the wiki: `<name>/<space>/<parent page>/<page>.md`. | The Confluence REST API, re-rendering only pages whose version number changed; a signed webhook on Data Center, or the sync interval below |
| **Documentation site** | **Public pages only** (see below). A published site, found through its `sitemap.xml`, its `llms.txt` or a crawl from one start URL, written under the site's own paths: `<name>/guide/install.html`, converted to Markdown by the same transform `.html` files use. | Conditional GETs against the site (`ETag`/`Last-Modified`), inside the five crawl ceilings below |
| **Google Drive** | The files under the folders you share with a Google **service account** (see below), written under each folder's own name: `<name>/Handbook/Guide.md`. Google Docs become Markdown, Sheets `.xlsx` and Slides `.pptx`; other files are downloaded as they are. The account's key is stored encrypted. | One `changes.list` request for the freshness check; a run walks the folders and downloads only files whose Google version or checksum changed; the sync interval below |
| **GitHub issues** | The issues of one repository, and optionally its Discussions, one document each with its comments: `<name>/issues/12.md`, `<name>/discussions/4.md`. Closed issues are opt-in; pull requests are never indexed. A token is optional for a public repository (see below). | One conditional request for the most recently updated issue; a run reads only what changed since the last one |
| **S3 bucket** | The objects under one prefix of an S3-compatible bucket (AWS S3, MinIO, Ceph, Cloudflare R2…) whose file type the source reads, written under the prefix-relative key: `<name>/guides/install.md`. A key pair is stored encrypted (see below). | `ListObjectsV2`, downloading only objects whose ETag or size changed; the sync interval below |

Sources are synced at the start of every index run, one after another; a source that fails to sync is
reported on its own row and the others still index. **Sync** on a row and **Re-index** in the header
both queue the same run.

**Moving a source's address needs its credential again.** A Confluence source's *Site URL*, a git source's *URL*, an S3
source's *Endpoint* and a GitHub source's *API address* are where the stored credential is sent. An editor can change
them but cannot read the credential, so an edit that moved the host and kept the credential would let any editor send it
to a server of their choice. Such an edit is refused (`400 invalid_request`, naming the setting) unless the same request
also supplies the credential again or removes it (`secret: null` over the API; type the token again, or tick
*Remove the stored token*, in the dialog). Changing only the path on the same host, editing anything else, and editing a
source that stores no credential (a public repository) are not affected.

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

## Google Drive: folders shared with a service account

A **Google Drive** source indexes the trees under the folders you name (up to 50) that are **shared with a Google
service account**. The account is the only identity the source has: no user signs in, nothing is read through
domain-wide delegation, and the only scope requested is `drive.readonly`.

**Setting it up**

1. In a Google Cloud project, enable the **Google Drive API** (APIs & Services → Library).
2. Create a **service account** (IAM & Admin → Service accounts) and, under its **Keys** tab, add a key of type
   **JSON**. Google downloads the key file; this is the only time it can be fetched.
3. **Share each folder with the account's e-mail address** (`…@…iam.gserviceaccount.com`, the `client_email` of the
   key file) in Drive, as *Viewer*.
4. In the dashboard choose **Add source → Google Drive**, paste the folder links (or their ids), and load or paste
   the key file. The dialog shows the address to share with as soon as it reads the key.

**If you cannot create a key.** A Google Cloud organisation created on or after 3 May 2024 enforces the
`iam.managed.disableServiceAccountKeyCreation` policy by default, and creating a key then fails until an
organisation administrator relaxes the policy for the project. A standalone Google account's project is not
affected. This product has no other way in: workload identity federation and user OAuth are not supported.

- **The key** is stored encrypted with `SECRET_KEY` as one document holding the account's e-mail, the key id and
  the private key; the rest of the key file (its `token_uri` included) is not kept and never used, and nothing is
  ever returned by the API or shown again. Over the API the `secret` is the key file's JSON, as Google issued it.
  The e-mail is also written to the source's settings (`serviceAccountEmail`, read-only) so the dialog can say whom
  to share with. **Use one service account per source**: the account can read everything shared with it, and the
  list of folders only bounds what is indexed, not what the account can see. Replacing the key makes the next
  check run the source.
- **Export formats.** A Google Doc is exported as Markdown, a Sheet as `.xlsx` (every sheet, not only the first)
  and a Slides deck as `.pptx`; the last two are then converted like any uploaded file. Each is read only while its
  extension is ticked under **File types** (`.md`, `.xlsx`, `.pptx`). Other Google files — Forms, Drawings, Sites —
  are skipped and counted in the run's note, as are shortcuts, which are not followed.
- **Google refuses to export a file over 10 MB.** That file is named in the run's note (as over the size limit),
  the rest of the source is indexed, and the run still succeeds. A stored file listed over
  `MAX_CONVERTED_FILE_BYTES` is refused the same way and not downloaded.
- **Paths.** A file's path is its folder's name, then the names of the folders under it, then its own name, with `/`
  in a name replaced by `_`. Two siblings that share a name, and two root folders that share a name, all get
  ` (<first 8 characters of the id>)` added, so no two files meet in one path. A name that is empty, `.` or `..`,
  contains a NUL, or is over 255 bytes once suffixed is skipped and counted — with everything under it when it is
  a folder — and so are names starting with a dot, which the indexer never scans. A rename shows in `whats_new` as
  one removal and one addition.
- **What a check costs.** One `changes.list` request (page size 1) from the position the last successful run took,
  plus at most one sign-in an hour; nothing is listed or downloaded. Anything the account can see changing wakes
  the source — including a change in another source's folders when two sources share an account, which costs a
  walk and never a wrong answer. The run lists every folder (`files.list`, one request per folder) and fetches only
  files whose Google `version` (Docs, Sheets, Slides) or `md5Checksum` (stored files) changed, so a tree of
  thousands of folders makes a run, not a check, slow.
- **Bounds.** One source indexes at most `GDRIVE_MAX_FILES` files (5 000 by default, see
  [Configuration](configuration.md#file-ceiling-for-google-drive-sources)): the first ones in walk order (the
  folders in the order listed, depth first, each folder's children by name), and the note says in capitals that the
  rest are not indexed. A run that would leave less than `DATA_DIR_MIN_FREE_BYTES` free fails with
  `insufficient_disk` before it downloads anything; an export counts as 10 MiB for that check.
- **Network.** Requests go only to `oauth2.googleapis.com` and `www.googleapis.com`, over `https`, through the same
  egress guard as the other sources; a redirect to any other host is refused, and no allowlist setting applies.
  A server that reaches the internet through a proxy that rewrites TLS must trust that proxy's certificate.
- **Failures.** `429`, a `403` that says `rateLimitExceeded` or `userRateLimitExceeded`, a `5xx` and a network
  error are retried up to five times with a growing, jittered wait that honours `Retry-After`; each throttling
  answer is counted in `contextator_source_throttled_total{source_type="gdrive"}` (see
  [Observability](observability.md#source-throttling)). A folder that is not shared with the account is reported as
  `<folder id> is not shared with <account>`; a key Google no longer accepts (deleted, disabled, or a wrong clock
  on this server) says so; a project without the Drive API enabled says to enable it. A failed run moves neither
  the manifest nor the freshness check, and nothing is deleted until every download has succeeded.
- **Shared drives.** Requests carry the shared-drive parameters, so folders in a shared drive that the account is a
  member of should work, but this is **not verified**: treat it as unsupported until it is.
- **Export and import.** A project export carries the source's folders and settings, not its key or its position in
  Google's change feed; an imported Drive source arrives unscheduled and needs its key entered again.

## GitHub issues and Discussions

A **GitHub issues** source indexes the issues of one repository — and, when you turn it on, its Discussions — as one
document each, with the comments (and, for a Discussion, the replies) in the same document. It is a different source
from the **Git repository** one: the repository's files and its wiki come through `git`, and this source never reads
either. Add both when you want both; the dialog says so.

- **Documents.** `<name>/issues/<number>.md` and `<name>/discussions/<number>.md`. The front matter carries the title,
  the page URL (which search results and `read_document` return as the source link), the state, the labels, the author
  and the update time; the body is the issue or Discussion followed by its comments in order, each under a heading
  naming the author and the date. A Discussion's accepted answer is marked, and its replies sit one heading level down.
  Pull requests, which GitHub's issues API returns beside issues, are skipped. A thread longer than a million
  characters is cut at a comment boundary and says so.
- **What is in scope.** *Closed issues* are left out unless you tick **Closed issues too**; an issue that is closed
  later leaves the index at the next run, and returns if it is reopened. Every Discussion is a document, open or
  closed. *Bots* — comments and issues written by bot accounts — are kept unless you untick them. Issue and Discussion
  text routinely carries names, addresses and pasted credentials; it is indexed as written, and the findings view
  (when scanning is on) reports where such text sits.
- **The token is optional.** Without one, the source reads a **public** repository's issues, under GitHub's anonymous
  limit of 60 requests an hour per address — a limit every tokenless GitHub source on this server shares. With a token
  it also reads private repositories and may turn on **Discussions**, which GitHub serves through its GraphQL API and
  answers only for a signed-in caller: ticking Discussions with no token is refused with `400 invalid_request`. Use a
  **fine-grained personal access token** with read access to *Issues* (and *Discussions*) on that repository; a classic
  token works too. GitHub Apps are not supported. The token is stored encrypted with `SECRET_KEY` as the plain string
  you pasted, never returned or shown again, and counts as a credential for the backup's key check (a source with no
  token stores nothing and is not counted). A project export carries the settings and not the token.
- **GitHub Enterprise Server.** Set the **API address** to the server's REST base (`https://ghe.example.com/api/v3`);
  GraphQL is read from the matching `…/api/graphql`. Only `https` is accepted, because the token travels to it. A
  server that resolves to a private address must be named in `SOURCE_ALLOWED_HOSTS`
  ([Configuration](configuration.md#egress-allowlists-which-private-hosts-a-source-may-reach)).
- **What a check costs.** One request: `GET /issues?sort=updated&direction=desc&per_page=1` with the `ETag` of the last
  answer. GitHub answers `304`, which does not count against the primary rate limit when the request carries a token,
  and the run is skipped. With Discussions on there is one more request, a GraphQL query for the most recently updated
  Discussion. A comment, an edit, a close or a new issue all move the newest-updated issue and wake the source.
- **What a run costs.** The **first** run lists every issue (100 to a request), then every comment of the repository
  (100 to a request), so a repository costs about `issues/100 + comments/100` requests and no request per issue. An
  **incremental** run asks for the issues and the repository's comments updated since the last successful run began
  (moved back five minutes for clock skew), reads the comments of each issue that moved, and re-renders those documents
  only; an issue whose rendering did not change is not rewritten. If more than 100 issues moved, it lists everything
  instead.
- **Deletions are found on full runs.** GitHub's lists never show an issue that was deleted or transferred, and an
  edited or deleted comment does not always move its issue. So the **first** run, a run after the source's settings
  changed, and a run whose last full run is older than `SYNC_MAX_SKIP_HOURS` (24 hours when that is off) list every
  number and remove the documents whose number is gone and re-read every comment. Between full runs a deleted or
  transferred issue **stays searchable**, for up to that long. Pressing **Sync** does not force a full run. Changing the repository, the
  API address, or the closed / Discussions / bots settings starts over, and replacing the token forgets what the old one
  read.
- **Bounds.** One source indexes at most `GITHUB_MAX_ISSUES` issues (the most recently created first) and
  `GITHUB_MAX_DISCUSSIONS` Discussions, see [Configuration](configuration.md#ceilings-for-github-sources); past a ceiling the note says in
  capitals that the rest is not indexed.
- **Rate limits end the run.** A `429`, or a `403` that says the limit is spent (`x-ratelimit-remaining: 0`, a
  `retry-after`, or a rate-limit message), makes the run an `error` whose message gives the time the limit resets. The
  run is not retried and stores no cursor, so the next run starts from the same place and finds the same changes. A
  `5xx` answer or a network error is retried a few times. A rejected token, a repository that is missing or that the
  token cannot read, and Issues switched off in the repository are each named in the run's message.
- **Network.** Requests go only to the one API host of the source, through the same egress guard as the other
  sources; a redirect or a pagination link to any other host is refused, so the token cannot be led elsewhere. For the
  same reason, **changing the API address to another host while a token is stored is refused** unless the same request
  gives the token again (or removes it); see the note under the table at the top of this page.
- **Export and import.** A project export carries the repository, the settings and no token or cursor; an imported
  GitHub source arrives unscheduled, and a tokenless one runs as a public source.

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
| Google Drive | One `changes.list` request (page size 1) from the position the last run took | A walk of every folder |
| GitHub issues | One conditional request for the most recently updated issue (a `304` is free of the primary limit with a token), plus one GraphQL query with Discussions on | A listing of the issues and comments updated since the last run |
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

### Two ways to authorise a Notion source

| | Internal integration token | Connect with Notion (OAuth) |
| --- | --- | --- |
| You do | Create an internal integration, share the pages with it, paste its token | Pick the pages in Notion's own page picker |
| Needs on the instance | `SECRET_KEY` | `SECRET_KEY` and a **public connection you registered yourself**, with `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` and a redirect URI |
| Stored | The token, encrypted with `SECRET_KEY` | The access and refresh token, encrypted with `SECRET_KEY`, and the workspace name beside them |
| Webhook | Yes, [push webhooks](#push-webhooks) work as before | **No.** A public connection's webhook belongs to the connection, not to one source, so an OAuth source has no webhook section; it is kept fresh by the schedule and its revision check |
| When Notion refuses the token | The source fails with that message; paste a new token | The tokens are refreshed once and the request repeated; if Notion no longer accepts the refresh token, the run fails and asks for **Reconnect** |

Both are always available: with no Notion OAuth variables set, the dashboard shows only the token field and
nothing else changes. There is no Contextator-owned connection, so every instance registers its own.

**Register the public connection** at `notion.so/profile/integrations` (a *public* connection, not an internal
one). Its **redirect URI** must be the address Notion sends the browser back to, and it must name this instance:

- `https://<your-domain>/api/sources/notion/oauth/callback` for a deployed instance. Set `PUBLIC_BASE_URL` and the
  server derives the same address; or set `NOTION_OAUTH_REDIRECT_URI` to pin it.
- `http://localhost:<port>/api/sources/notion/oauth/callback` for an instance on your own machine.
- **Open the dashboard on that same host.** Sign-in cookies belong to a host name: if the redirect URI says
  `localhost` and you opened the dashboard at `127.0.0.1`, Notion sends the browser back to a host where you
  are not signed in, and the callback answers `401`.
- **Not an IP address.** `http://127.0.0.1:...` is reported to be refused by Notion's form, and the server never
  guesses a redirect URI from a request: with neither `NOTION_OAUTH_REDIRECT_URI` nor `PUBLIC_BASE_URL` set,
  startup is refused.

Then **Connect with Notion** appears in the Notion tab of *Add source*. Only a signed-in editor of the project
can use it (an API token or `ADMIN_TOKEN` cannot start it, because it is a browser round trip). The source is
created when Notion sends the person back, and **Reconnect** on an existing OAuth source authorises it again
without changing its name or its settings. A project export drops the tokens like every other secret, so an
imported OAuth source needs Reconnect. The tokens are never shown, returned by the API, or written to a log.

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
