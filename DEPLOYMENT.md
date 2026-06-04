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

### Build & push images (multi-arch — required)

⚠️ **Build multi-arch.** A plain `docker build` on Apple Silicon produces an
**arm64-only** image. It runs fine on a local arm64 minikube but fails on
amd64 nodes (GKE) with `ErrImagePull: no match for platform in manifest`. Use
`buildx` with both platforms so the same tag works everywhere:

```bash
# one-time: a builder that supports multi-platform output
docker buildx create --use --name multi 2>/dev/null || docker buildx use multi

# --push is required for multi-arch (it assembles the manifest list)
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.server -t puppiesarecute/obscura-server:1.0.2 --push .
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.client -t puppiesarecute/obscura-client:1.0.2 --push .
```

Registry = `puppiesarecute` (Docker Hub, public — GKE pulls it with no
imagePullSecret). Verify a tag is multi-arch with:
`docker buildx imagetools inspect puppiesarecute/obscura-server:1.0.2`.

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
4. **Images** — edit the tags directly in `server.yaml` / `client.yaml`.
   > The `images:` block in `kustomization.yaml` is currently a **no-op**: its
   > names (`obscura-server`) don't match the fully-qualified image in the
   > Deployments (`puppiesarecute/obscura-server`), so `kustomize edit set image`
   > won't touch them. Either edit the `image:` line in each Deployment, or align
   > the names first. (The standalone `kustomize` CLI isn't required —
   > `kubectl apply -k` has it built in.)

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

**New image with a NEW tag** (the clean way) — bump the `image:` tag in
`server.yaml` / `client.yaml`, then apply:

```bash
# e.g. edit deploy/k8s/server.yaml → image: puppiesarecute/obscura-server:1.0.3
kubectl apply -k deploy/k8s/
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

## 3. GKE + ingress-nginx + Let's Encrypt (the live setup)

This is the exact path used to put the app on `https://ltka.org` on a **GKE
Autopilot** cluster. `kubectl apply -k deploy/k8s/` gets you Pods + Services, but
the Ingress needs a controller, an IP, and a cert. Three extra pieces:

### 3a. Connect kubectl to GKE

```bash
gcloud config set project <project-id>
gcloud container clusters get-credentials <cluster> --region <region>
kubectl config current-context        # now the GKE cluster
```

Your manifests use `ingressClassName: nginx`, but **GKE has no nginx controller
by default** (its built-in is GCE). Install ingress-nginx so the cluster behaves
like the docker-compose / minikube path. No Helm needed — use the cloud static
manifest:

```bash
# pick the current release tag from github.com/kubernetes/ingress-nginx
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/cloud/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=180s
```

### 3b. Reserve a static external IP (so DNS never goes stale)

The controller's LoadBalancer gets an **ephemeral** IP that can change if the
Service is recreated. Promote the IP it was handed to a reserved static one
(same address → zero disruption), then pin it on the Service:

```bash
IP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
gcloud compute addresses create obscura-ingress-ip \
  --project=<project-id> --region=<region> --addresses="$IP"
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p "{\"spec\":{\"loadBalancerIP\":\"$IP\"}}"
echo "Point DNS at: $IP"
```

Cost: an in-use reserved IP is the same ~\$3–4/mo as the ephemeral one you're
already paying for; only a *detached* reserved IP costs extra.

### 3c. cert-manager + Let's Encrypt — with the Autopilot fix

Install cert-manager, then **immediately run the Autopilot patch** (see the
gotcha below), then create the issuers:

```bash
# pick the current release from github.com/cert-manager/cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.20.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=ready pod --all --timeout=180s

# REQUIRED on GKE Autopilot — patches leader-election ns + applies lease RBAC
./deploy/k8s/cert-manager-autopilot-patch.sh

# CA bundle should now be a long string (not 0):
kubectl get validatingwebhookconfiguration cert-manager-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | wc -c

kubectl apply -f deploy/k8s/cluster-issuer.yaml          # LE staging + prod
kubectl get clusterissuer                                # both Ready=True
```

The Ingress already carries `cert-manager.io/cluster-issuer: letsencrypt-prod`,
so `kubectl apply -k deploy/k8s/` triggers issuance into the `obscura-tls`
secret. Watch it:

```bash
kubectl -n obscura get certificate,order,challenge -w   # certificate → Ready=True
```

> ⚠️ **GKE Autopilot + cert-manager gotcha** (the part that isn't obvious):
> cert-manager's static manifest defaults leader-election to the `kube-system`
> namespace, which Autopilot **forbids** (`denied by managed-namespaces-limitation`).
> The cainjector then can't acquire its lease → never injects the webhook CA
> bundle → every issuer/cert apply fails with
> `x509: certificate signed by unknown authority`. The fix
> ([`cert-manager-autopilot-patch.sh`](deploy/k8s/cert-manager-autopilot-patch.sh)
> + [`cert-manager-autopilot-rbac.yaml`](deploy/k8s/cert-manager-autopilot-rbac.yaml))
> repoints leader-election to the `cert-manager` namespace **and** grants the
> matching lease RBAC there. (Installing cert-manager via Helm with
> `--set global.leaderElection.namespace=cert-manager` does both automatically —
> a cleaner option if you have Helm.)

### 3d. DNS — and Cloudflare's catch

Create an **A record** for the apex `ltka.org` → the static IP from 3b. Apex
domains can't be a CNAME, so it must be an A record.

If the domain is on **Cloudflare**, turn the proxy **OFF (grey cloud / DNS-only)**
for this record. With the orange-cloud proxy on:
- DNS returns Cloudflare's edge IPs, hiding your origin; and
- Let's Encrypt's HTTP-01 challenge can't reach your origin, so issuance hangs.
- (If Cloudflare SSL mode is *Full (strict)* you'll also see **HTTP 526** until
  the origin has a cert Cloudflare trusts.)

DNS-only makes `ltka.org` resolve straight to the ingress IP, the HTTP-01
challenge validates, and the cert issues. *(Keeping the Cloudflare proxy is a
valid alternative — then you'd use a Cloudflare Origin Certificate instead of
Let's Encrypt — but that's a different path than the manifests here assume.)*

Verify end to end:

```bash
curl -sI https://ltka.org/ | grep -i strict-transport        # HSTS present
curl -s https://ltka.org/api/auth/login/challenge \
  -X POST -H 'content-type: application/json' \
  -d '{"email":"nobody@example.com"}'                          # 200 + KDF JSON
```

---

## Image notes

- Both images are multi-stage and build from the **repo root** context so the
  Yarn workspace and `@obscura/shared` resolve. `.dockerignore` keeps host
  `node_modules`/`dist` out of the build.
- The server runtime image carries the full installed `node_modules` (kept
  simple over minimal). If image size matters later, prune to the server's
  production deps in a dedicated stage.
