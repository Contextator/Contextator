# contextator (Helm chart)

Deploys Contextator on Kubernetes: one Pod, against a PostgreSQL (pgvector) database you already run.
This chart does not bundle a database and does not offer more than one replica — both are deliberate,
see [ADR-0078](../../../.ssot/ADR.md#adr-0078). For the two Docker paths (embedded PostgreSQL, or `slim` +
`DATABASE_URL`), see the product root `README.md` and `.ssot/OPERATIONS.md` §1 instead; this chart only
ever deploys the `slim` image, i.e. the external-database topology.

## Prerequisites

- Kubernetes ≥ 1.24, Helm ≥ 3.8.
- A reachable PostgreSQL 16+ database with the `pgvector` extension installed. This chart never starts
  one for you.
- A `StorageClass` that supports `ReadWriteOnce`, for the two PVCs this chart creates (uploads/sources,
  and the embedding model cache).

## Install

```sh
helm install ctx ./charts/contextator \
  --set database.url="postgres://user:pass@db.example.internal:5432/contextator" \
  --set image.tag="<your-slim-image-tag>"
```

Or, pointing at a Secret you already manage instead of passing the URL on the command line:

```sh
helm install ctx ./charts/contextator \
  --set database.existingSecret=my-db-secret \
  --set database.existingSecretKey=DATABASE_URL \
  --set image.tag="<your-slim-image-tag>"
```

Either `database.url` or `database.existingSecret` is **required**. If neither is set, the chart fails
`helm install`/`helm template` immediately with an explicit error, rather than rendering a Pod that
would crash-loop on a missing `DATABASE_URL` — this chart carries no embedded PostgreSQL to fall back
to (unlike the product's own Docker default image; see [ADR-0069](../../../.ssot/ADR.md#adr-0069)).
Verified: `helm install ctx ./charts/contextator` with no `database.*` set exits non-zero with a message
naming the missing value, before any Kubernetes object is created.

`image.tag` is **also required** and has no default. `contextator/contextator` on Docker Hub does not
publish a `-slim` tag yet (only `latest`, `0.1`, `0.1.0`, none built from the slim target — ADR-0062
names the tag scheme, but publishing an image under it is a separate, not-yet-made decision; see
[ADR-0078](../../../.ssot/ADR.md#adr-0078)). Point `image.tag` (and `image.repository`, if needed) at a
`slim`-target image you built and pushed yourself until one is published under the default repository.

After install, `helm test ctx` runs a hook Pod that calls `GET /api/health` on the Service and prints
the response — the same check described under "No `wget`/`curl` in the image" below.

## Replicas

**Not a value you can set.** This chart always deploys exactly one Pod (`replicas: 1`, hardcoded in
`templates/deployment.yaml`) and does not expose a `replicaCount` key in `values.yaml` at all — not a
value that is validated and rejected, a value that was never offered. `--set replicaCount=2` has no
effect on the rendered manifests; there is nothing named `replicaCount` for it to set.

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
model download from Hugging Face on first start; see "Kaynak ölçümü" below for the measured figure.

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

## Kaynak ölçümü (resource sizing methodology)

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

## Publishing

This chart is currently install-from-local-path only (`helm install ctx ./charts/contextator`). Whether
to publish it to an OCI registry or a `gh-pages` chart index is a separate product decision, not yet
made — see [ADR-0078](../../../.ssot/ADR.md#adr-0078)'s Decision section, last bullet.
