# Deploy

captatum ships a generic, **infra-agnostic** container image. The hosted
flavor runs as one stateful gateway replica behind a reverse tunnel (e.g.
Cloudflare Tunnel), with OAuth and client state in two SQLite files on a private
volume. The actual
deployment configuration — registry, network, DB host, tunnel token, hostnames,
secrets — lives in the **private infrastructure repository**, not here. This
public repo intentionally contains no infra internals.

## Image

```bash
docker build -t captatum .
# or, for a remote registry:
docker buildx build --platform linux/arm64 -t <your-registry>/captatum:<tag> --push .
```

The image runs `node --no-warnings src/server.ts` (hosted flavor). The gateway
image deliberately contains no Chromium. Tier-3 requires the separate production
browser workload described below; the generic Compose, EC2, and Railway templates
leave it disabled.

## Runtime configuration

See [`.env.example`](../.env.example) for the full env shape:
`CAPTATUM_FLAVOR=hosted`, `OAUTH_*`, `CAPTATUM_SQLITE_PATH`, `MCP_ALLOWED_*`,
`CAPTATUM_TRUSTED_PROXY_CIDRS`, `CAPTATUM_PROXY_AUTH_SECRET`, and
`OPENROUTER_API_KEY`. Secrets (OAuth ES256 JWK, proxy authenticator, DB
password) must come from your secret manager — never baked into the image.

## Health & MCP

- `GET /healthz` → `{ "status": "ok" }` (the only unauthenticated route).
- MCP clients call `POST /mcp` with a gateway-issued OAuth bearer token.

## Two flavors

- **Hosted**: Streamable HTTP `/mcp` + gateway OAuth; reachable from web agents.
- **Self-contained local binary**: `bun build --compile` → one executable, no
  auth, single-user. No deployment needed.

## Hosted topology

The hosted flavor runs as one gateway replica with:
- **gateway** (`captatum`) — the MCP + fetch service (`node --no-warnings src/server.ts`).
- a **reverse-tunnel** sidecar (e.g. `cloudflared`) — exposes the gateway without an inbound port.
- an optional **browser workload** — long-lived Chromium over CDP for Tier-3
  render, with no OAuth keys, store, or secret-bearing environment.

The reverse tunnel's forwarding headers carry authority only with both its
allowlisted socket address and the edge-injected proxy authenticator. The gateway
applies the same gate to forwarded address, host, protocol, and port headers,
then erases the authenticator from parsed and raw header views before route
dispatch.

The browser must never share the gateway or tunnel network namespace. A
compromised no-sandbox browser could otherwise bind a temporarily free gateway
port and receive the tunnel's authenticated traffic. The supported production
shape gives the browser its own Pod/network namespace, permits CDP ingress only
from the gateway, and installs a default-deny IPv4/IPv6 OUTPUT firewall before
Chromium starts. The browser's page requests still route through the gateway's
guarded fetcher. The CDP allowlist accepts only an exact Kubernetes Service
origin shaped `http://<service>.<namespace>.svc.cluster.local:9222`; the deployer
owns the concrete service and namespace labels. Loopback and non-service
endpoints fail boot before state is opened.

Concrete registry, orchestrator, tunnel, hostname, and secret configuration is
deployer-owned. This public repo ships the images and enforces the runtime
boundary above; it intentionally does not duplicate environment-specific
manifests.

## Deploy shape

Whatever orchestrator you run, a hosted release is roughly:

1. Build + push the gateway image (and, when `Dockerfile.browser` / `scripts/browser-sidecar.sh` change, the browser image) to your registry. `release.yml` publishes multi-arch images to GHCR on a tagged release.
2. Bump the image tag in your workload manifest and apply it.
3. Replace the old replica without overlap; v0.20.0's stored-DCR migration must
   never serve concurrently with a pre-v0.20 replica.
4. Wait for the new pod to become **Ready** (readiness probe is `GET /healthz`).
5. Live-probe `POST /mcp` → expect `401` (alive + auth-gating).

## Gotchas (independent of where you host)

- **Apply only after the image is pullable.** Confirm the tag exists in the registry before you bump the manifest, or the pod stays in `ImagePullBackOff`.
- **Tier-3 needs the isolated browser workload.** If
  `CAPTATUM_BROWSER_CDP_ENDPOINT` is unset, the gateway reports
  `render-unavailable` without crashing. Do not point it at loopback or place a
  browser in the gateway namespace; both are rejected deployment shapes. After
  deploying the reviewed production topology, confirm a Tier-3 render end-to-end.
- **The browser image's Chromium major must match the gateway's `playwright` pin** — only bump the browser tag when `Dockerfile.browser` / `scripts/browser-sidecar.sh` change.
