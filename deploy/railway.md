# Railway deploy

Railway runs the **gateway** as a single service from the published image, with a
persistent volume for the SQLite store. Cloudflare Access + Tunnel sit in front.

## Steps

1. **New project → deploy from image**: `ghcr.io/acartag7/captatum:<tag>` (use the
   latest release tag). (Alternatively, connect this repo and Railway builds from
   `Dockerfile`; `railway.toml` sets the start command + healthcheck.)
2. **Add a volume**: Settings → Volumes → mount at `/data`. It must be writable by
   the gateway user and mode `0700`. Set `CAPTATUM_SQLITE_PATH=/data/captatum.sqlite`;
   the client store is created beside it as `/data/captatum.sqlite.clients`.
3. **Environment variables**: paste your `.env` (see `deploy/README.md` §1). Generate
   the OAuth keys with `node --no-warnings scripts/gen-oauth-keys.ts` first.
4. **Public domain**: Railway assigns one; point `OAUTH_ISSUER` / `OAUTH_RESOURCE` /
   `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` at it.
5. **Cloudflare Access + Tunnel**: front the Railway domain with Cloudflare so the
   `/oauth/authorize*` consent screen is behind Access (required at boot). Put the
   Access `CF_ACCESS_*` values in the env.

## Tier-3 (optional JS rendering)

Tier-3 requires the gateway to reach Chromium over **loopback** CDP — the renderer
rejects non-loopback CDP endpoints (TIER3-CDP-1), and the sidecar binds loopback.
Railway services do **not** share a network namespace, so a *separate* browser
service cannot be reached on `127.0.0.1`. Options:

1. **Leave `allowRender` off** (default) — no browser, no Tier-3. Fine if you don't
   need JS-rendered pages (most pages resolve at Tier-1).
2. **Single combined image** bundling the gateway + Chromium in one container
   (shared loopback) with `CAPTATUM_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222`.
   Not the default release image; build it by combining `Dockerfile` with the
   sidecar entrypoint (`scripts/browser-sidecar.sh`).

If you need Tier-3 with a separate sidecar (the `network_mode: service:gateway`
pattern), use **EC2** (`ec2-user-data.sh`) or **Mac Mini** (`mac-mini.md`), where
the gateway and sidecar share a network namespace.
