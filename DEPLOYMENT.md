# Deploying Obscura

Three pieces: **Postgres**, the **server** (Hono API + encrypted-sync
WebSocket), and the **client** (Vite SPA served by nginx). nginx in the client
container reverse-proxies `/api` — both HTTP and the `/api/sync` WebSocket — to
the server, so the browser only ever talks to one origin. That matches what the
client code assumes: relative `/api` fetches and a WS URL built from
`location.host`. The server stays a dumb append-and-relay layer over opaque
E2EE blobs, so the database only ever holds ciphertext.

```
browser ──▶ client (nginx :80) ──┬─ static SPA  (/, /assets)
                                 └─ proxy /api  ──▶ server (:3000) ──▶ Postgres (:5432)
```

---

## 1. Docker Compose (start here)

```bash
cp .env.example .env          # then edit secrets, esp. POSTGRES_PASSWORD
docker compose up --build     # builds server + client images, starts the stack
```

Open <http://localhost:8080>. The server runs DB migrations automatically on
boot, so the schema is ready on first start.

Useful:

```bash
docker compose logs -f server     # watch API/sync logs
docker compose ps                 # health status
docker compose down               # stop (keeps the pgdata volume)
docker compose down -v            # stop and wipe the database volume
```

### Knobs (`.env`)

| Var                 | Default                 | Notes                                              |
| ------------------- | ----------------------- | -------------------------------------------------- |
| `POSTGRES_USER`     | `obscura`               | DB user                                            |
| `POSTGRES_PASSWORD` | `change-me-in-prod`     | **change this**                                    |
| `POSTGRES_DB`       | `obscura`               | DB name                                            |
| `CLIENT_PORT`       | `8080`                  | host port the client is published on               |
| `CLIENT_ORIGIN`     | `http://localhost:8080` | public origin for CORS — must match how you load it |

### Real TLS in front of compose

The payload is already E2EE, but transport should still be HTTPS/WSS. Put a TLS
terminator (Caddy/Traefik/an nginx with certs, or a cloud LB) in front of the
client container and set `CLIENT_ORIGIN=https://your-domain`. The server emits
HSTS when it sees `X-Forwarded-Proto: https`, which nginx forwards.

---

## 2. Kubernetes (when you outgrow a single box)

Manifests live in [`deploy/k8s/`](deploy/k8s/) (plain YAML + a Kustomization).
Same topology as compose: the Ingress sends the host to the **client** Service,
whose nginx serves the SPA and proxies `/api` to the **server** Service.

### Build & push images

```bash
docker build -f Dockerfile.server -t puppiesarecute/obscura-server:1.0.1 .
docker build -f Dockerfile.client -t puppiesarecute/obscura-client:1.0.1 .
docker push puppiesarecute/obscura-server:1.0.1
docker push puppiesarecute/obscura-client:1.0.1
```
(registry = puppiesarecute)

### Configure

1. **Secret** — don't commit it. Either copy `secret.example.yaml` →
   `secret.yaml` and edit, or:
   ```bash
   kubectl create namespace obscura
   kubectl -n obscura create secret generic obscura-secrets \
     --from-literal=POSTGRES_PASSWORD='obscura-very-safe-password' \
     --from-literal=DATABASE_URL='postgres://obscura:obscura-very-safe-password@db:5432/obscura'
   ```
2. **ConfigMap** (`configmap.yaml`) — set `CLIENT_ORIGIN` to your real host.
3. **Ingress** (`ingress.yaml`) — set the host and TLS secret.
4. **Images** — pin tags via Kustomize:
   ```bash
   cd deploy/k8s
   kustomize edit set image \
     obscura-server=puppiesarecute/obscura-server:1.0.1 \
     obscura-client=puppiesarecute/obscura-client:1.0.1
   ```

### Apply

```bash
kubectl apply -k deploy/k8s/          # namespace, config, db, server, client, ingress
kubectl -n obscura get pods -w
```

### Redeploying

`kubectl apply -k` is declarative — it only changes what differs from the
cluster — but *how* you redeploy depends on what changed.

**Changed a manifest** (ingress, service, etc.) — just re-apply:

```bash
kubectl apply -k deploy/k8s/
```

**Changed a ConfigMap** (e.g. `CLIENT_ORIGIN`) — apply does NOT restart pods that
read it as env vars, so the server keeps the old value until you restart it:

```bash
kubectl apply -k deploy/k8s/
kubectl rollout restart deployment/server -n obscura   # re-reads CLIENT_ORIGIN
```

**New image with a NEW tag** (the clean way) — point the manifest at it, then apply:

```bash
cd deploy/k8s
kustomize edit set image puppiesarecute/obscura-server=puppiesarecute/obscura-server:1.0.1
kubectl apply -k .
```

**Rebuilt and pushed the SAME tag** — K8s can't tell the image changed (the tag
string is identical) and the node may reuse its cached copy, so force a fresh
rollout:

```bash
kubectl rollout restart deployment/server -n obscura
```

Reusing a tag is why this is fragile — prefer bumping the tag (`1.0.0` → `1.0.1`)
so every redeploy is unambiguous and `rollout undo` works.

**Watch / verify / revert:**

```bash
kubectl rollout status deployment/server -n obscura    # blocks until done or fails
kubectl rollout undo deployment/server -n obscura      # revert to the previous version
```

Same commands apply to `deployment/client` (swap the name).

Notes:

- **Postgres** runs as a single-replica StatefulSet with a 5Gi PVC. For real
  production, prefer a managed database (RDS / Cloud SQL) and just point
  `DATABASE_URL` at it — the server only stores opaque blobs.
- **Migrations** run on server boot. The Kysely migrator locks, so scaling the
  server is safe; run them as a one-shot `Job` first if you'd rather gate
  rollout on a clean migration.
- **WebSocket**: the Ingress annotations bump proxy timeouts so long-lived sync
  sockets aren't reaped; nginx-ingress passes upgrades through by default.

---

## Image notes

- Both images are multi-stage and build from the **repo root** context so the
  Yarn workspace and `@obscura/shared` resolve. `.dockerignore` keeps host
  `node_modules`/`dist` out of the build.
- The server runtime image carries the full installed `node_modules` (kept
  simple over minimal). If image size matters later, prune to the server's
  production deps in a dedicated stage.
