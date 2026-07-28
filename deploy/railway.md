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
6. **Trusted proxy peer**: set `CAPTATUM_TRUSTED_PROXY_CIDRS` only to Railway's
   documented final proxy peer IP/CIDR as observed by the service. If Railway
   cannot provide a stable narrow peer range, this hosted auth release cannot be
   deployed there securely; do not use `0.0.0.0/0` or a private-range wildcard.
7. **Authenticated forwarding**: set `CAPTATUM_PROXY_AUTH_SECRET` and configure
   the Cloudflare hostname rule to **Set static** `X-Captatum-Proxy-Auth` to the
   same value. Railway's peer range alone is not forwarding authority.

## Tier-3 rendering

The checked Railway shape is gateway-only, so Tier-3 reports
`render-unavailable`. Do not bundle Chromium into the gateway container or point
the gateway at loopback: a no-sandbox browser sharing the gateway network
namespace can impersonate the gateway after a restart.

Tier-3 requires an orchestrator that can provide the reviewed production
boundary: a distinct browser network namespace, CDP ingress only from the
gateway, and a default-deny IPv4/IPv6 OUTPUT firewall installed before Chromium
starts. The gateway accepts only the exact production Kubernetes browser service
origin. Railway is therefore not a supported Tier-3 target for this release.
