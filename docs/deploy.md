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

The image runs `node --no-warnings src/server.ts` (hosted flavor). Tier-3
(Playwright) ships module-only (no Chromium) by default; to enable render, use a
browser-capable base image and unset `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`.

## Runtime configuration

See [`.env.example`](../.env.example) for the full env shape:
`CAPTATUM_FLAVOR=hosted`, `OAUTH_*`, `CAPTATUM_SQLITE_PATH`, `MCP_ALLOWED_*`,
`OPENROUTER_API_KEY`. Secrets (OAuth ES256 JWK, DB password) must come from your
secret manager — never baked into the image.

## Health & MCP

- `GET /healthz` → `{ "status": "ok" }` (the only unauthenticated route).
- MCP clients call `POST /mcp` with a gateway-issued OAuth bearer token.

## Two flavors

- **Hosted**: Streamable HTTP `/mcp` + gateway OAuth; reachable from web agents.
- **Self-contained local binary**: `bun build --compile` → one executable, no
  auth, single-user. No deployment needed.

## Hosted topology

The hosted flavor runs as a pod with **three** containers:
- **gateway** (`captatum`) — the MCP + fetch service (`node --no-warnings src/server.ts`).
- a **reverse-tunnel** sidecar (e.g. `cloudflared`) — exposes the gateway without an inbound port.
- a **browser sidecar** — long-lived Chromium over CDP for Tier-3 render, isolated to its own blast radius (no OAuth keys, no store, no env).

The concrete deployment (registry, orchestrator manifest, tunnel token, hostname, secrets) is declared in the **private infrastructure repository** and applied with whatever that repo uses. This public repo ships only the image and the runtime configuration above.

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
- **Tier-3 needs the sidecar.** If `CAPTATUM_BROWSER_CDP_ENDPOINT` is unset or the browser container isn't running, the gateway falls back to Tier-1 (no crash). After deploy, confirm a Tier-3 render end-to-end.
- **The browser image's Chromium major must match the gateway's `playwright` pin** — only bump the sidecar tag when `Dockerfile.browser` / `scripts/browser-sidecar.sh` change.
