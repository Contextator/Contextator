# Command line

The `contextator` command is in the image, both the default one and `-slim`. It is a small client of the
[admin API](admin-api.md) for what you would otherwise write as four `curl` calls and a polling loop in a CI
job: create a project from a git repository, wait for its index, mint an MCP token. It is not on npm and
is not a separate download; it is the version of the image you already run.

```bash
docker run --rm \
  -e CONTEXTATOR_URL=https://docs.example.com -e CONTEXTATOR_TOKEN \
  contextator/contextator:0.6.0-slim \
  contextator project create handbook --git https://github.com/acme/handbook --wait
```

`contextator` as the first argument makes the container run the command and nothing else: no server, no
database, no model download. Started as root it runs the command as `node`, so that nothing it writes (a backup on
a bind mount) is left owned by root; started as another user (`--user`) it runs as that user. Any other start of
the image is unchanged. `docker run --entrypoint contextator …` and, in a running container,
`docker exec <name> contextator …` work too, with the same rule.
When the instance is another container, put both on one network (`--network`) and use its service name in
`CONTEXTATOR_URL`.

## Connecting

| | |
|---|---|
| `CONTEXTATOR_URL` | The instance's address, e.g. `https://docs.example.com` (or `--url`). A path prefix is kept. |
| `CONTEXTATOR_TOKEN` | An account's [API token](accounts-and-permissions.md) (or `ADMIN_TOKEN`), or `--token-file <path>`. |

The token is never an argument: an argument shows in the process list and in shell history. The command refuses
`--token` and says where the token goes. Use an API token scoped to the routes the commands below call
(`POST /api/projects`, `POST /api/projects/:id/sources`, `GET /api/projects/:id/status`,
`GET /api/projects/:id/runs`, `GET /api/projects/:id/sources`, `POST /api/projects/:id/mcp-tokens`, `GET /api/projects`
to look a project up by name)
in preference to `ADMIN_TOKEN`. It cannot be restricted to one project when it creates the project, and creating
one needs an instance `admin`. Over plain `http://` to anything but loopback the command warns that the
token travels unencrypted. It does not follow redirects, because a credential belongs to the address it was
configured for.

At the start of every command it reads `/api/health`, and warns if the server's version is not its own. The admin
API is not versioned, so use the same image tag for both.

## Commands

### `project create <name> --git <url>`

Creates the project, adds a git source of the same name, and queues its first index run.

| Option | |
|---|---|
| `--git <url>` | The repository, `http(s)`. A URL with credentials in it is refused. |
| `--branch`, `--subdir` | As on a git source; omitted, the server's defaults apply. |
| `--git-token-env <VAR>` | The *name* of the variable holding the git token, for a private repository. It is stored on the git source and used by every later sync, so it must outlive the job that passes it: not a CI job token such as GitHub's `GITHUB_TOKEN`. |
| `--wait` | Wait until the index run ends. |
| `--timeout <d>` | Longest `--wait`: `90s`, `15m`, `1h` (default `15m`). |
| `--exists-ok` | A project with this name existing is not an error: it is returned and no second source is added. If it has no source (an earlier run created the project and its source call failed) the source is added, so retrying completes it. It never starts a new index run on a project that has a source. |
| `--json` | One JSON object on stdout: `{ project: { id, name, mcpUrl }, mcpToken?: { token, secret }, run?: { id, status } }`. |
| `--show-secret` | Print the first MCP token's secret (it is printed with `--json` too). |

The project's **first MCP token is returned by the server once**, at creation. Without `--json` or `--show-secret`
it is not printed, and the command says so; it exists nowhere else, so mint another with `token create`. A
project that already existed (`--exists-ok`) has no first token to give. If the project is created and the source is
refused, the project stays (nothing is rolled back), the message names its id, and the secret is printed first when
`--json` or `--show-secret` asked for it; run the command again with `--exists-ok` to add the source.

`--wait` polls the project's job every 2 seconds, growing to 15, and prints the phase on stderr as it
changes. A network failure or a `502`/`503`/`504` inside the timeout is retried, so a server that restarts during
a long index does not fail the job. No single request may outlast what is left of `--timeout`. When the wait ends in an error or a timeout the result is still printed, so the
secret above is not lost with it; the project and source are kept, and `project status <name> --wait` waits again.

### `project status <name|id>`

Where the project's index stands: the job in flight, or the newest recorded run. With `--wait` it waits for a job
in flight to end (`--timeout` as above) and exits `5` if the run failed; without it, it reports and exits `0`.
A project that has never been indexed has nothing to wait for and exits `1`.

### `token create --project <name|id>`

Mints an MCP token for the project (`POST /api/projects/:id/mcp-tokens`).

| Option | |
|---|---|
| `--name <text>` | A label. |
| `--expires-in-days <30\|90\|365>` | Default: never. |
| `--allowed-cidr <cidr>` | A network allowed to present the token; repeat for several. |
| `--json` or `--show-secret` | **One is required**: the secret is shown once, and a token minted and not printed could never be read. The command refuses before it creates anything. |

It mints an **MCP** token. An account's API token can only be created from a signed-in dashboard session, so
the command cannot make one.

### `backup [args]`

Runs the backup you already have, `npm run backup`, with the arguments as given
([deployment](deployment.md)). Unlike the other commands it does not use the admin API: it needs access to the
database and the data directory, and `pg_dump`, which only the default image has. On the `-slim` image it
reports that `pg_dump` is missing.

## Output and exit codes

Progress and warnings go to **stderr**, the result to **stdout**, so `result=$(contextator … --json)` captures
the result alone. Nothing secret is written to stderr, and the git token is never printed.

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | An unexpected error, a server error (`5xx`), or a request the server refused as invalid. |
| `2` | Usage: an argument or a required variable is wrong or missing. Nothing was sent. |
| `3` | `401` or `403`: the credential was not accepted or may not do this. |
| `4` | `404` or `409`: no such project, or the project already exists. |
| `5` | `--wait`: the index run ended in `error`. |
| `6` | `--wait`: it ran out of time. |
| `7` | The server could not be reached. |

## In CI

[`examples/github-actions-contextator.yml`](examples/github-actions-contextator.yml) creates a project for the
repository, waits for its index with the `-slim` image, and mints a token for an agent, masking it in the log.
It creates the project once; a later run only reports it, because `--exists-ok` starts no new index run. Keep the
index current with the source's sync schedule or a push webhook ([document sources](document-sources.md)), and
give a private repository a long-lived read-only token, not the job's `GITHUB_TOKEN`.
