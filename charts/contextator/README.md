# contextator (Helm chart)

Deploys Contextator on Kubernetes: one Pod, against a PostgreSQL (pgvector) database you already run.
This chart does not bundle a database and does not offer more than one replica — both are deliberate
(project decision record ADR-0078). For the two Docker paths (embedded PostgreSQL, or `slim` +
`DATABASE_URL`), see the product root `README.md` instead; this chart only ever deploys the `slim`
image, i.e. the external-database topology.

## Prerequisites

- Kubernetes ≥ 1.24, Helm ≥ 3.8.
- A reachable PostgreSQL 16+ database with the `pgvector` extension installed. This chart never starts
  one for you.
- A `StorageClass` that supports `ReadWriteOnce`, for the two PVCs this chart creates (uploads/sources,
  and the embedding model cache).

## Install

From the chart repository (published to GitHub Pages by the release workflow; see "Publishing" below —
the repository answers only after the first release that carries the chart):

```sh
helm repo add contextator https://contextator.github.io/Contextator
helm repo update
helm install ctx contextator/contextator \
  --set database.url="postgres://user:pass@db.example.internal:5432/contextator" \
  --set-string image.tag="<version>-slim"
```

Or from a checkout of this repository:

```sh
helm install ctx ./charts/contextator \
  --set database.url="postgres://user:pass@db.example.internal:5432/contextator" \
  --set image.tag="<version>-slim"
```

Or, pointing at a Secret you already manage instead of passing the URL on the command line:

```sh
helm install ctx ./charts/contextator \
  --set database.existingSecret=my-db-secret \
  --set database.existingSecretKey=DATABASE_URL \
  --set image.tag="<version>-slim"
```

Either `database.url` or `database.existingSecret` is **required**. If neither is set, the chart fails
`helm install`/`helm template` immediately with an explicit error, rather than rendering a Pod that
would crash-loop on a missing `DATABASE_URL` — this chart carries no embedded PostgreSQL to fall back
to (unlike the product's own Docker default image; decision record ADR-0069).
Verified: `helm install ctx ./charts/contextator` with no `database.*` set exits non-zero with a message
naming the missing value, before any Kubernetes object is created.

`image.tag` is **also required** and has no default. It must point at an image built from the `slim`
target. **No `-slim` tag has been published yet:** `contextator/contextator` on Docker Hub carries only
`latest`, `0.1` and `0.1.0`, all three the full image with an embedded PostgreSQL — the wrong topology
for this chart, which is why the chart does not fall back to its `appVersion` either. The release
workflow publishes the `slim` target as `<version>-slim`, `<major>.<minor>-slim` and `latest-slim`
starting with the first release after `v0.1.0`; `<version>-slim` in the commands above only resolves
from then on. Until that release exists, build the `slim` target yourself (`docker build --target slim`),
push it to your own registry, and point `image.repository`/`image.tag` at it.

After install, `helm test ctx` runs a hook Pod that calls `GET /api/health` on the Service and prints
the response — the same check described under "No `wget`/`curl` in the image" below.

## Replicas

**Not a value you can set.** This chart always deploys exactly one Pod (`replicas: 1`, hardcoded in
`templates/deployment.yaml`) and does not offer a `replicaCount` key in `values.yaml`. The missing key
is deliberate, not an oversight: there is nothing to set (ADR-0078). Because the values schema rejects
unknown keys (see "Strict values schema" below), `--set replicaCount=2` fails `helm install`,
`helm upgrade` and `helm template` with an `additional properties 'replicaCount' not allowed` error
instead of being silently ignored.

This is not an arbitrary limit: MCP sessions live in the application process's own memory
(`src/mcp/sessions.ts`) and the indexer runs a single in-process queue (ADR-0009). A second replica
would not share either — it would silently split sessions and in-flight indexing state across two Pods
rather than add capacity. If you need more headroom, raise `resources.limits` instead. Horizontal
scaling is out of scope for this product (`ROADMAP.md`, "Deliberately not").

## Database

The chart only ever deploys the `*-slim` image, which carries no PostgreSQL of its own. You must supply
one of:

- `database.url` — a full `postgres://` connection string. The chart writes it into a Secret it owns
  (`<release>-contextator-database`) and mounts it as `DATABASE_URL`.
- `database.existingSecret` / `database.existingSecretKey` — an existing Secret you manage, for
  operators who source database credentials from an external secrets manager. When set, `database.url`
  is ignored and this chart does not create a database Secret at all.

Neither set → `helm install`/`helm template`/`helm upgrade` fail before rendering any object
(`_helpers.tpl` calls `fail` with the missing-value message). This was verified against a live cluster:
the install command with no `database.*` value exits immediately with that error and creates nothing.

## `SECRET_KEY`

`SECRET_KEY` encrypts source credentials (git/Notion tokens, etc.) at rest and is **never plaintext in
this chart's values** for a supported install path:

- `secretKey.existingSecret` / `secretKey.existingSecretKey` — point at a Secret you manage. Preferred
  for production.
- Leave both empty → the chart generates a random 44-character key on first `helm install` and writes it
  to a Secret it owns (`<release>-contextator-secret-key`). Because `templates/secret.yaml` uses Helm's
  `lookup` function to read that Secret's *existing* data back on every subsequent `helm upgrade`, the
  same value is kept stable across upgrades rather than being regenerated each time. `lookup` always
  returns nothing under `helm template` / `helm install --dry-run`, so a dry run renders a fresh random
  value each time — expected, and harmless, since nothing is actually applied.
  - This value is **not** preserved across `helm uninstall` + reinstall, and it is not backed up
    anywhere by the chart. If you lose it, previously stored source tokens become undecryptable and
    those sources need reconnecting. Treat the generated Secret as something to back up, or switch to
    `existingSecret` and manage it in your own secrets tooling.
- `secretKey.value` exists only as a local/dev convenience (e.g. a throwaway kind cluster). **Do not**
  commit a real value under this key to a values file that lands in version control — pass it with
  `--set secretKey.value=...` or `--set-file` at install time instead, or use `existingSecret`.

Confirmed by grep across `values.yaml` and every file under `templates/`: `SECRET_KEY` never appears as
a literal string value anywhere in the chart, only as a key name and as the target of a
`secretKeyRef`/`stringData` reference built from the values above.

### GitOps and `helm template`: pin the key

The generated key is only stable when Helm itself talks to the cluster (`helm install` / `helm
upgrade`), because that is the only time `lookup` can read the existing Secret back. Anything that
renders the chart **without** cluster access gets an empty `lookup` and therefore a **new random key
on every render**:

- Argo CD, which renders Helm charts with `helm template` and applies the output itself, and any other
  GitOps tool that renders manifests instead of running `helm upgrade` against the cluster;
- `helm template … | kubectl apply -f -`, and any pipeline that commits rendered manifests.

(Flux's helm-controller runs real `helm install`/`helm upgrade` releases, so `lookup` works there.)

Each sync then overwrites the Secret with a different key. Stored git/Notion tokens and webhook secrets
that were encrypted under the previous key stop decrypting, and every private source stops syncing. On
those install paths, do not let the chart generate the key — create it once and point the chart at it:

```sh
kubectl -n <namespace> create secret generic contextator-secret-key \
  --from-literal=SECRET_KEY="$(openssl rand -hex 32)"
```

```yaml
secretKey:
  existingSecret: contextator-secret-key
  existingSecretKey: SECRET_KEY
```

With `existingSecret` set the chart renders no `SECRET_KEY` Secret at all, so a render can no longer
change the key. Keep that Secret (or its value) in your own secrets tooling — a sealed/external secret,
a vault — and back it up; the chart does not. The same applies to an ordinary `helm install` if you
want the key to survive `helm uninstall` (see "Uninstall").

### If the key has already changed

- **You still have the old key** (a backup of the Secret, the value from before a GitOps sync, a
  secrets-manager history). Rotate onto the new key instead of re-entering tokens: pin the new key with
  `existingSecret` as above, give the process the old one as `SECRET_KEY_PREVIOUS` (for example via
  `envSecret`, from a second Secret you create), let the Pod restart, then run the rotation inside it:

  ```sh
  kubectl -n <namespace> get deploy -l app.kubernetes.io/instance=<release>
  kubectl -n <namespace> exec deploy/<deployment-name> -- npm run rotate-secret
  ```

  The Deployment is named `<release>-contextator`, except when the release name already contains
  `contextator` (then it is just the release name) or `fullnameOverride` is set (then it is that
  value); the first command prints the name either way.

  When it reports nothing left to convert, remove `SECRET_KEY_PREVIOUS` again and let the Pod restart —
  that removal is what retires the old key. The root `README.md` (`SECRET_KEY` and
  `SECRET_KEY_PREVIOUS`, and its security section) describes the rotation in full; the decision record
  is ADR-0075.
- **The old key is gone.** Nothing can decrypt what it wrote. Pin a new key with `existingSecret` so
  it does not happen again, then reconnect each private source by entering its token again in the
  dashboard. Public sources and already-indexed content are not affected.

## Ingress and reverse proxies

Enabling `ingress` does **not** make the application trust the Ingress controller. `TRUST_PROXY` is
set only from `config.trustProxy`, never inferred from `ingress.enabled`: the chart cannot know what
actually sits in front of the Pod (an ingress controller, a cloud load balancer, a CDN, or all three),
and a trust setting that is guessed is one a caller can exploit. Left empty, the app's own default
applies (`0`: `X-Forwarded-*` headers are ignored).

Behind an Ingress, set these together:

```yaml
config:
  publicBaseUrl: "https://contextator.example.com"
  trustProxy: "<ingress-controller-pod-ip-or-cidr>"   # only the addresses the controller connects from
env:
  AUTH_COOKIE_SECURE: "1"
```

Leaving `config.trustProxy` empty behind an Ingress breaks three things silently: the per-IP sign-in
limit becomes instance-wide (every request carries the controller's address), MCP connectors fail to
authorize with `invalid_target` when `publicBaseUrl` is also unset (published URLs read `http` while
clients use `https`), and the session cookie loses its `Secure` flag. The root `README.md`, *Running
behind a reverse proxy*, explains each one.

**Name the proxy, not the network your clients are on.** The list is matched against every hop, not
just the socket's peer. Use the narrowest range that covers the ingress controller Pods (their IPs,
or a dedicated node/Pod range if your CNI gives the controller one). Do **not** paste the cluster's
whole Pod CIDR (for example `10.244.0.0/16`) without a NetworkPolicy: that range also covers every
other Pod that can reach this Service, any of which could then forge `X-Forwarded-For` and move the
per-IP sign-in limit or the recorded client address. Trusting the whole range is only as safe as a
NetworkPolicy that lets nothing but the ingress controller reach this Pod's port. `"1"` trusts whoever wrote the header, every hop of it — use
it only when that NetworkPolicy exists. A hop count is not accepted. Also check that your ingress
controller **replaces** an incoming `X-Forwarded-For` rather than appending to what the client sent;
no setting here can tell the difference.

## Persistence

Two `ReadWriteOnce` PVCs, both enabled by default:

| Value | Mount | Purpose | Required for |
|---|---|---|---|
| `persistence.data` | `/data` | Materialised git/Notion checkouts and uploaded files | Uploaded files surviving a pod restart |
| `persistence.models` | `/app/.cache/models` | Downloaded embedding model cache (~470MB at fp32) | Avoiding a ~70s re-download + reload on every pod restart |

Verified against a live cluster: a file written to `/data` survives `kubectl delete pod` (the
Deployment's `Recreate` strategy schedules a fresh Pod that remounts the same PVC) — the file was
re-read byte-for-byte identical from the new Pod. `persistence.data.existingClaim` /
`persistence.models.existingClaim` let you point at a PVC you provisioned yourself instead of letting
the chart create one.

## Probes

Liveness and readiness are deliberately different checks:

- **Liveness** — a bare TCP check on the app port. It must never depend on the database: if it did, a
  database outage this process cannot fix on its own would also crash-loop a process that is otherwise
  healthy, adding restart churn on top of an outage that is not the Pod's fault.
- **Readiness and startup** — `GET /api/health`, which the application already uses for its own Docker
  `HEALTHCHECK`. (The phase brief that prompted this chart referred to this loosely as `/healthz`; the
  route that actually exists in this codebase, and the one this chart uses, is `/api/health` —
  confirmed via `grep -rn "healthz" src/`, zero matches.) `/api/health` answers HTTP 503 the moment the
  database pool cannot reach the database, which readiness turns into "remove this Pod from the
  Service's endpoints" without touching liveness or the restart count.

Verified live: scaling the backing database to zero replicas produced `READY 0/1`, an empty
`kubectl get endpoints` list for the Service, and `RESTARTS 0` throughout the outage. Scaling the
database back up recovered the Pod to `READY 1/1` with endpoints repopulated automatically, still with
zero restarts — the Pod was never killed, only taken out of rotation and put back.

The startup probe's generous `failureThreshold` (30 × 10s ≈ 5 minutes) exists to cover a cold embedding
model download from Hugging Face on first start; see "Resource sizing" below for the measured figure.

## Security context / running as root

The container **must** start as uid 0. The image's own entrypoint checks `id -u = 0`, refuses to run
otherwise, `chown -R node:node`s the mounted `/data` and `/app/.cache/models` volumes so the app can
write to them regardless of the volume's on-disk ownership, and only then re-execs the application as
the unprivileged `node` user via `gosu`. This was not assumed — it was found by installing this chart
against a live cluster with a conventional hardened `securityContext`
(`runAsNonRoot: true`, `capabilities.drop: [ALL]`), which made the container exit immediately with
"the container must start as root."

Because of this, `podSecurityContext` and `securityContext` in `values.yaml` are intentionally minimal:
no `runAsNonRoot`, no fixed `runAsUser`, no capability drop. The one restriction that costs nothing is
kept: `allowPrivilegeEscalation: false` — the root→node handoff is `setuid()`/`setgid()` inside a
root-owned process, not an exec of a setuid binary, so disallowing privilege escalation does not break
it. There is currently no image variant that starts directly as `node`; if one is added in the future,
this chart's default `securityContext` should be revisited.

## No `wget`/`curl` in the image

`contextator/contextator:*-slim` is a Debian (bookworm)-based image with only Node.js installed — no
`wget`, `curl`, or `busybox`. This was found the hard way: this chart's `helm test` hook and
`NOTES.txt` originally shelled out to `wget` for the health check, and a real `helm test ctx --logs` run
against the live cluster failed with `sh: 3: wget: not found` (`Phase: Failed`). Both now use `node -e`
with the runtime's own built-in `fetch()` (`AbortSignal.timeout(10000)`) instead — re-verified with a
real `helm test ctx --logs` run afterwards, which reported `Phase: Succeeded` with the actual
`200 {"ok":true,...}` response body in the hook Pod's logs. If you need to check health manually from
inside the cluster without `helm test`, see `templates/NOTES.txt`'s step 4 for the `node -e` one-liner —
there is no shell HTTP client to fall back to.

## Resource sizing

`values.yaml`'s `resources.requests`/`resources.limits` are measured, not guessed. Source: `docker
stats` against the `slim` image, run in an earlier rehearsal of this same install (external pgvector 16,
default `EMBEDDING_DTYPE=fp32`):

- **Idle / query-serving baseline:** ~770–820 MiB RSS with the fp32 embedding model warm (loaded once,
  held in memory). `resources.requests.memory` (1Gi) sits above this with headroom; `requests.cpu`
  (500m) covers steady request handling without over-reserving on small clusters.
- **Indexing burst:** CPU briefly hit ~10 cores for 2–3 seconds on a 12-core host during a reindex —
  ONNX Runtime (the embedding backend) parallelises a batch across every visible core. A 41-document /
  ~200-chunk warm reindex completed in ~4.5s. `resources.limits.cpu` (2 cores) caps this burst rather
  than reserving it: indexing runs slower under the limit instead of starving other workloads on the
  same node. Raise it if an instance indexes large corpora often.
- **Cold start:** first embedding model load (download + init) measured at ~72.4s. This is why the
  startup probe's `failureThreshold` is generous (≈5 minutes) rather than tight, and why mounting
  `persistence.models` matters — without it, every Pod restart re-pays this cost.

If you change `env.EMBEDDING_DTYPE` to `fp16` or `q8` to shrink the model's memory footprint, lower
`resources` accordingly — the figures above are for the fp32 default.

## Uninstall

```sh
helm uninstall ctx
```

The two PVCs carry `helm.sh/resource-policy: keep` (`persistence.retainOnUninstall`, default `true`)
and are **not** deleted by `helm uninstall`; remove them separately if you want the data gone too
(`kubectl delete pvc -l app.kubernetes.io/instance=ctx`), or set `persistence.retainOnUninstall: false`
before uninstalling to have Helm delete them itself. The generated `SECRET_KEY` Secret has no such
policy and **is** deleted with the release — back it up first if you intend to reinstall against the
same database.

## Values reference

See `values.yaml` itself — every setting is documented inline there, which is the chart's actual
contract. The sections above explain the *why* behind the values that are not self-explanatory
(`database.*`, `secretKey.*`, `resources.*`, `probes.*`, `securityContext`); everything else
(`service`, `ingress`, `env`, `envSecret`, `extraVolumes`, …) follows ordinary Helm chart conventions.

## Strict values schema

`values.schema.json` is strict (ADR-0092): every object level rejects keys it does not list, every
scalar has a type, and closed value sets (`image.pullPolicy`, `service.type`, `ingress…pathType`,
persistence `accessModes`) are enums. A misspelt or mistyped value therefore fails `helm install`,
`helm upgrade` and `helm template` before anything is rendered — `--set image.tagg=x`,
`--set foo=bar` and `--set-string service.port=80` all exit non-zero. Values are checked with their
type, so a numeric-looking string (an image tag such as `1.2`, an `env` value such as `1`) needs
`--set-string` or quoting in a values file.

Structures Kubernetes itself leaves open are bounded by their type only and accept any inner shape:
`resources`, `affinity`, `tolerations`, `podSecurityContext`, `securityContext`, `extraVolumes`,
`extraVolumeMounts`, and the string-to-string maps `nodeSelector`, `podAnnotations`, `podLabels` and
every `annotations`. `env` accepts any variable name with a string value; `envSecret` accepts any name,
but each entry must be exactly `{secretName, secretKey}`.

Two application settings have typed keys under `config` rather than going through `env`, so the schema
checks them:

- `config.confluenceAllowedHosts` — a list of host names (not URLs), joined into
  `CONFLUENCE_ALLOWED_HOSTS`. Empty leaves the variable unset.
- `config.mcpStructuredOutput` — `true` sets `MCP_STRUCTURED_OUTPUT=1`. `false` (the default) leaves it
  unset.

## Publishing

The release workflow (`.github/workflows/release.yml`, job `chart`) runs on every `v*` tag and
publishes this chart with `helm/chart-releaser-action` only when `charts/contextator/` changed since
the previous tag: it packages the chart, attaches the `.tgz` to a GitHub release named
`contextator-<chart version>`, and updates the `index.yaml` on the `gh-pages` branch, served at
`https://contextator.github.io/Contextator`. A tag with no chart change publishes nothing, and a
chart version that is already published is skipped, never overwritten (decision record ADR-0092).
The `cr` binary the action drives is installed by the job itself and checked against the upstream
release's SHA-256 before it runs.

One-time setup, in this order, before the first tag that carries the chart: create the `gh-pages`
branch (an empty orphan branch is enough), turn GitHub Pages on for it, then push the tag. The job
checks for the branch first and fails before publishing anything if it is missing. If the job fails
for that or any other reason, fix the cause and use "Re-run failed jobs" on the same workflow run: a
later tag does not make up for it, because the next run only looks at chart changes since that
previous tag. With Pages off, the job succeeds but the repository URL answers 404 until Pages is
turned on.

Versioning (ADR-0092): `version` in `Chart.yaml` is bumped on every chart change — patch for a fix,
minor for a new value, major for a removed or renamed value or a value the schema newly rejects. CI
fails a change to `charts/contextator/` that does not raise `version`. `appVersion` is the application
release the chart was last tested with; it is not an image default (`image.tag` stays required).
Whoever cuts a release that publishes the chart sets `appVersion` to that tag without its `v`
(`v1.4.0` → `"1.4.0"`) before tagging; the `chart` job fails otherwise.
