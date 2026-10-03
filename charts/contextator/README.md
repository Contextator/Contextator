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
  --set-string image.tag="<version>-slim"
```

Or, pointing at a Secret you already manage instead of passing the URL on the command line:

```sh
helm install ctx ./charts/contextator \
  --set database.existingSecret=my-db-secret \
  --set database.existingSecretKey=DATABASE_URL \
  --set-string image.tag="<version>-slim"
```

Either `database.url` or `database.existingSecret` is **required**. If neither is set, the chart fails
`helm install`/`helm template` immediately with an explicit error, rather than rendering a Pod that
would crash-loop on a missing `DATABASE_URL` — this chart carries no embedded PostgreSQL to fall back
to (unlike the product's own Docker default image; decision record ADR-0069).
Verified: `helm install ctx ./charts/contextator` with no `database.*` set exits non-zero with a message
naming the missing value, before any Kubernetes object is created.

`image.tag` is **also required** and has no default. It must point at an image built from the `slim`
target. The release workflow publishes the `slim` target as `<version>-slim`, `<major>.<minor>-slim` and
`latest-slim` from `v0.2.0` on. The tags without the suffix (`latest`, `0.2`, `0.2.0`, and `v0.1.0`'s
tags, which have no `-slim` twin) are the full image with an embedded PostgreSQL — the wrong topology
for this chart, which is why the chart does not fall back to its `appVersion` either. To run a build
of your own, build the `slim` target (`docker build --target slim`), push it to your own registry,
and point `image.repository`/`image.tag` at it.

After install, `helm test ctx` runs a hook Pod that calls `GET /api/health` on the Service and prints
the response — the same check described under "No `wget`/`curl` in the image" below.

## Chart version and `appVersion`

**The chart's version is independent of the product's version** (decision record ADR-0092). The two
numbers move for different reasons and do not have to match:

- `version` in `Chart.yaml` is the chart's own SemVer. It changes when anything under
  `charts/contextator/` changes, and only then — patch for a fix, minor for a new value, major for a
  removed or renamed value or one the schema newly rejects. A product release that leaves the chart
  alone publishes no new chart version.
- `appVersion` is the application release the chart was last tested with. It is informational: it is
  not an image default, and `image.tag` stays required. Chart `1.0.0` with `appVersion: "0.2.0"` and
  an image tag of `0.2.1-slim` is a normal combination, as long as the chart's values cover what that
  image needs.

When you upgrade, pin the chart with `helm upgrade --version <chart version>` and the product with
`image.tag`; read the chart's changes from its own version, not from the product's. See "Publishing"
below for how and when a chart version is published.

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
  that removal is what retires the old key. "Rotating `SECRET_KEY`" below gives the same steps in
  order, with the backups around them. The root `README.md` (`SECRET_KEY` and
  `SECRET_KEY_PREVIOUS`, and its security section) describes the rotation in full; the decision record
  is ADR-0075.
- **The old key is gone.** Nothing can decrypt what it wrote. Pin a new key with `existingSecret` so
  it does not happen again, then reconnect each private source by entering its token again in the
  dashboard. Public sources and already-indexed content are not affected.

## Secrets from External Secrets Operator

The chart never needs a secret in its values: `database.existingSecret`, `secretKey.existingSecret`
and `envSecret` each point at a Secret you own. With the
[External Secrets Operator](https://external-secrets.io) (ESO), that Secret is materialised from your
secret store, and the chart only names it. One `ExternalSecret` can carry every value the app reads
from a Secret:

```yaml
apiVersion: external-secrets.io/v1   # v1beta1 on ESO releases older than v0.17
kind: ExternalSecret
metadata:
  name: contextator
  namespace: <namespace>              # the release's namespace
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: <your-store>                # e.g. a Vault, AWS Secrets Manager or GCP Secret Manager store
  target:
    name: contextator                 # the Secret ESO creates and keeps in sync
    creationPolicy: Owner
  data:
    - secretKey: DATABASE_URL
      remoteRef: { key: contextator/prod, property: database_url }
    - secretKey: SECRET_KEY
      remoteRef: { key: contextator/prod, property: secret_key }
    - secretKey: METRICS_TOKEN        # only if you scrape /metrics (see "Prometheus Operator")
      remoteRef: { key: contextator/prod, property: metrics_token }
```

```yaml
# values file — no secret value appears in it
database:
  existingSecret: contextator
  existingSecretKey: DATABASE_URL
secretKey:
  existingSecret: contextator
  existingSecretKey: SECRET_KEY
envSecret:
  METRICS_TOKEN:
    secretName: contextator
    secretKey: METRICS_TOKEN
```

With `database.existingSecret` and `secretKey.existingSecret` set, this chart renders no Secret of its
own, so a `helm template`-based GitOps sync cannot change the key either (see "GitOps and `helm
template`" above). Create the `ExternalSecret` before the release: a Pod whose `secretKeyRef` points at
a Secret that does not exist yet stays in `CreateContainerConfigError` until it does.

Two things ESO does not do for you:

- **The Pod does not reload a changed Secret.** These values reach the app as environment variables,
  read once at start. After ESO syncs a new value, restart the Pod
  (`kubectl -n <namespace> rollout restart deploy/<deployment-name>`), or let a reloader controller do
  it.
- **Changing `SECRET_KEY` in the store is a key rotation**, and done on its own it is the "key has
  already changed" case above: stored source tokens stop decrypting at the next restart. Change it only
  as part of the procedure in "Rotating `SECRET_KEY`" below, which adds the old key as
  `SECRET_KEY_PREVIOUS` in the same step.

## Taking a backup

**The backup and restore commands, and the order they run in, live in one place: the product
README's [Data and persistence](https://github.com/Contextator/Contextator/blob/main/README.md#data-and-persistence) section** — `npm run backup`,
`npm run restore … --check`, `npm run restore`, and the application restart that follows a restore.
They are not repeated here (decision record ADR-0073: a procedure that overwrites a live database has
one transcript). This section covers only what is different on Kubernetes: where those commands can
run, and which PostgreSQL client they need.

**Not in the chart's Pod.** `npm run backup` and `npm run restore` need the PostgreSQL client programs
(`pg_dump`, `pg_restore`), and the `*-slim` image this chart deploys has none: `kubectl exec … npm run
backup` stops, saying `pg_dump` is not on the container's `PATH` (refusal `no_pg_tools`), and writes
nothing. A `pg_dump` taken by your database provider is a
copy of the database alone — no upload trees, and not an archive `npm run restore` accepts — so it
does not stand in for one.

**In a throwaway copy of the running Pod, on the default image.** The default image
(`contextator/contextator:<version>`, the same `<version>` as your `-slim` tag, without the suffix)
carries the client programs. A copy of the Pod has the same `DATABASE_URL`, `SECRET_KEY` (and
`SECRET_KEY_PREVIOUS`, if set), the rest of the environment and the same data PVC, and runs on the same
node so it can mount that `ReadWriteOnce` volume:

```sh
NS=<namespace>
# Only a Running Pod of this release: a finished or failed `helm test` Pod carries the same labels.
POD=$(kubectl -n "$NS" get pod \
  -l app.kubernetes.io/instance=<release>,app.kubernetes.io/name=contextator \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n "$NS" debug "$POD" --copy-to=contextator-backup --same-node \
  --set-image='contextator=contextator/contextator:<version>' \
  --container=contextator -- sleep infinity
kubectl -n "$NS" wait --for=condition=Ready pod/contextator-backup --timeout=5m
```

- `-- sleep infinity` replaces the image's entrypoint, so the copy starts **no** second application
  server and no embedded PostgreSQL; it only holds the environment and the volume for `exec`.
- `kubectl debug --copy-to` drops the Pod's labels and probes by default, so the copy is not behind
  the Service and nothing restarts it.
- If you mirror images into your own registry, mirror the default image of that version as well, and
  use that reference in `--set-image`.
- Delete the copy (`kubectl -n "$NS" delete pod contextator-backup`) as soon as the archive is off the
  PVC, and make a new copy for every backup — a copy carries the environment of the Pod at the moment
  it was made.

**PostgreSQL 17 and later: the client must match the server's major version.** The default image
ships the PostgreSQL **16** client, and this chart supports PostgreSQL 16 and later. `pg_dump` refuses
a newer server (`aborting because of server version mismatch`), and `pg_restore` 16 cannot read a dump
`pg_dump` 17 wrote (`unsupported version (1.16) in file header`). So before running anything in the
copy, read the server's major version and, for 17 and later, install the matching client from the
PostgreSQL apt repository the image already has configured:

```sh
# Server major version: 160004 -> 16, 170011 -> 17.
PG_MAJOR=$(kubectl -n "$NS" exec contextator-backup -- \
  sh -c 'psql "$DATABASE_URL" -XAtc "SHOW server_version_num"' | awk '{ print int($1 / 10000) }')

if [ "$PG_MAJOR" -gt 16 ]; then
  kubectl -n "$NS" exec contextator-backup -- sh -c \
    "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client-$PG_MAJOR"
fi
```

Then run each command the product README gives inside the copy with that client first on `PATH`:
`kubectl -n "$NS" exec contextator-backup -- sh -c "PATH=/usr/lib/postgresql/$PG_MAJOR/bin:\$PATH <command>"`
(for 16 that directory is the image's own client). For a restore, `PG_MAJOR` is the major version of
the server you restore **into**.

- Installing the 17+ client needs egress from the copy to `apt.postgresql.org` (and the Debian
  mirrors), and root in the container with a writable root filesystem — the chart's defaults
  (`podSecurityContext: {}`, no `readOnlyRootFilesystem`). If your cluster blocks either, build an
  image `FROM contextator/contextator:<version>` that installs `postgresql-client-<major>`, push it to
  your registry, and use it in `--set-image`; the `PATH` prefix stays the same.
- `psql` reads `DATABASE_URL` as a libpq connection URI. If yours carries query parameters libpq does
  not know, read the version with any client instead (`SHOW server_version_num`) and set `PG_MAJOR` by
  hand. `pg_dump --version` in the copy must report the server's major version.

**Translating the product README's commands.** They are written for Docker; on Kubernetes:

| Product README | On Kubernetes |
|---|---|
| `docker exec contextator <command>` | `kubectl -n "$NS" exec contextator-backup -- sh -c "PATH=/usr/lib/postgresql/$PG_MAJOR/bin:\$PATH <command>"` |
| `docker cp` to or from the container | `kubectl -n "$NS" cp` to or from `contextator-backup:<path>` |
| `docker compose restart contextator` (after a restore) | `kubectl -n "$NS" rollout restart deployment/<deployment-name>` — the application's Deployment, not the copy |

## Rotating `SECRET_KEY`

The app holds two keys during a rotation (decision record ADR-0075): `SECRET_KEY` is the key every
value is **written** with, and `SECRET_KEY_PREVIOUS` is **read-only** — it exists to open what the
retiring key wrote. Both must be at least 32 characters, `SECRET_KEY_PREVIOUS` is refused when
`SECRET_KEY` is unset, and it is refused when it equals `SECRET_KEY` (`src/config.ts`): the Pod exits
at start with that message rather than running with a keyring that cannot be what you meant. The
instance keeps serving throughout; nothing here needs a maintenance window.

The steps below assume both keys live in one Secret you own — `contextator` from the ESO example
above, or one created with `kubectl` — and that `secretKey.existingSecret` points at it. If the chart
generated the current key, first copy its value out of `<release>-contextator-secret-key` into that
Secret, so the chart no longer owns the key you are about to change. `B1`–`B3` are the backup steps of
ADR-0093; leave none of them out.

1. **B1 — back up under the current key**, before anything changes. Take a backup as
   [Taking a backup](#taking-a-backup) describes, with the archive named
   `contextator-pre-rotation-<date>.tar.gz`. It runs from a copy of the Pod, because the `-slim`
   image cannot take one (`no_pg_tools`). Do not go on to step 2 without the archive in hand.
2. **Make the current key the previous one, and put a new key in its place — in one change.** In the
   Secret (or in the secret store, for ESO): `SECRET_KEY_PREVIOUS` = the value `SECRET_KEY` has now,
   `SECRET_KEY` = a new value (`openssl rand -hex 32`). Then expose the new entry to the Pod and roll it:

   ```yaml
   envSecret:
     SECRET_KEY_PREVIOUS:
       secretName: contextator
       secretKey: SECRET_KEY_PREVIOUS
   ```

   Make sure the Secret already carries both keys before this upgrade (with ESO: after it has synced),
   or the new Pod waits in `CreateContainerConfigError`. `helm upgrade` with that value restarts the
   Pod because the Deployment changed. If you changed only
   the Secret, run `kubectl rollout restart` as well (see the ESO section above).
3. **Convert what is stored.** Re-runnable, safe to interrupt, safe to run twice:

   ```sh
   kubectl -n <namespace> exec deploy/<deployment-name> -- npm run rotate-secret
   ```

   It exits `0` when nothing is left under the old key and `1` when something is; it prints counts and
   row ids, never a token, a key or a ciphertext. A row it reports as undecryptable was written under a
   key that is no longer in the environment: re-enter that source's credential in the dashboard, run
   the command again, and do not go on to step 4 until it exits `0`.
4. **B2 — back up under the new key**, only after step 3 exited `0` and before step 5. This is the
   oldest archive the rotated instance can restore. Take it as
   [Taking a backup](#taking-a-backup) describes, named
   `contextator-post-rotation-<date>.tar.gz`, from a **new** copy of the Pod — one made after step 2's
   restart, so it runs with the new `SECRET_KEY`.
5. **Retire the old key.** Remove the `envSecret.SECRET_KEY_PREVIOUS` entry and `helm upgrade` — the
   Pod restarts without the variable — and only then delete `SECRET_KEY_PREVIOUS` from the Secret (a
   `secretKeyRef` to a key that is gone would keep the Pod from starting). Removing the variable is what
   actually retires the key; until then the running instance still opens everything it wrote.
6. **B3 — keep the retired key**, labelled and not beside the archives, until the retention of the
   oldest pre-rotation archive has expired; only then discard it. From step 2 on, `restore` into this
   instance refuses a pre-rotation archive that holds source credentials, because it compares the
   archive's key check value with `SECRET_KEY` only; restoring such an archive means setting
   `SECRET_KEY` back to the retired key — a rollback to the pre-rotation instance, not a step of the
   rotation.

The product's operations manual (`OPERATIONS.md` §5.20, in the project's `.ssot/` decision records)
describes the same procedure for the Docker install and explains each step; decision records ADR-0075
and ADR-0093 are the source of it.

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

## Prometheus Operator (ServiceMonitor)

The app serves Prometheus metrics at `GET /metrics`, on the same port as everything else (the Service's
`http` port). Set `metrics.serviceMonitor.enabled: true` to render a `ServiceMonitor`
(`monitoring.coreos.com/v1`) that scrapes it. It is off by default because the kind exists only where
the Prometheus Operator's CRDs are installed — enabling it on a cluster without them fails the install
with `no matches for kind "ServiceMonitor"`.

`/metrics` is **not public** (decision record ADR-0055): without a credential it answers `401`. The
credential meant for a scraper is `METRICS_TOKEN` (16+ characters, `openssl rand -hex 32`), which reaches
`/metrics` and nothing else. Put it in a Secret and reference it through `envSecret`; the
ServiceMonitor reads the bearer token from **that same entry**, so the Pod and the scraper cannot
disagree:

```sh
kubectl -n <namespace> create secret generic contextator-metrics \
  --from-literal=METRICS_TOKEN="$(openssl rand -hex 32)"
```

```yaml
envSecret:
  METRICS_TOKEN:
    secretName: contextator-metrics
    secretKey: METRICS_TOKEN
metrics:
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack   # whatever your Prometheus's serviceMonitorSelector matches
```

The rendered endpoint carries `authorization: {type: Bearer, credentials: <that Secret key>}`. The
Secret has to be in the release's namespace — the ServiceMonitor is created there and the Prometheus
Operator reads the credential from the ServiceMonitor's own namespace — and your Prometheus must be
allowed to select ServiceMonitors from that namespace (`serviceMonitorNamespaceSelector`).

Without `envSecret.METRICS_TOKEN`, no `authorization` block is rendered. That only works when the app
answers `/metrics` with no credential at all, i.e. with `env.METRICS_PUBLIC: "1"` — meant for a
deployment where something else (a NetworkPolicy, a proxy) already decides who reaches the port.
Otherwise every scrape gets `401` and the target shows as down. `METRICS_TOKEN` set through plain
`env` is not picked up by the ServiceMonitor; use `envSecret`.

Other settings: `annotations`, `honorLabels`, and `relabelings` / `metricRelabelings`, which are passed
through to the endpoint as written. `interval` and `scrapeTimeout` are Prometheus durations (`30s`,
`1m30s`). A `scrapeTimeout` longer than `interval` is refused at render time: the Prometheus Operator
would drop that endpoint without failing the install, and the target would simply never appear in
Prometheus. `/metrics` answers `200` even while the
database is down — `contextator_db_up` is the series that says so — and the operations manual
(`OPERATIONS.md` §6.3) lists what each metric means.

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
(`database.*`, `secretKey.*`, `resources.*`, `probes.*`, `securityContext`,
`metrics.serviceMonitor.*`); everything else
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
`extraVolumeMounts`, `metrics.serviceMonitor.relabelings` / `metricRelabelings`, and the
string-to-string maps `nodeSelector`, `podAnnotations`, `podLabels`, `metrics.serviceMonitor.labels` and
every `annotations`. `metrics.serviceMonitor.interval` and `scrapeTimeout` must be Prometheus
durations with their units in descending order (`y`, `w`, `d`, `h`, `m`, `s`, `ms` — `30s`, `1m30s`),
the format the Prometheus Operator CRD itself accepts. `env` accepts any variable name with a string value; `envSecret` accepts any name,
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
checks for the branch first and fails before publishing the chart if it is missing. If the `chart`
job fails for that or another infrastructure reason (the network, the release upload, the index
push), fix the cause and use "Re-run failed jobs" on the same workflow run: a later tag does not make
up for it, because the next run only looks at chart changes since that previous tag. With Pages off,
the job succeeds but the repository URL answers 404 until Pages is turned on.

Versioning (ADR-0092): `version` in `Chart.yaml` is bumped on every chart change — patch for a fix,
minor for a new value, major for a removed or renamed value or a value the schema newly rejects. CI
fails a change to `charts/contextator/` that does not raise `version`. `appVersion` is the application
release the chart was last tested with; it is not an image default (`image.tag` stays required).
Whoever cuts a release that publishes the chart sets `appVersion` to that tag without its `v`
(`v1.4.0` → `"1.4.0"`) before tagging. Otherwise the `chart-preflight` job fails before the image
job starts, so nothing is published — no image, no chart. Re-running that run does not help, since it
checks the same commit: fix `appVersion` (and raise `version`, as for any chart change), commit it and
push a tag on the new commit (the failed tag published nothing, so it can be deleted and pushed again
there).
