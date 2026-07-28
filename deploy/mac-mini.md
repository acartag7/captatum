# Mac Mini deploy (cloudflared + Docker)

Run the gateway + browser sidecar in Docker on a Mac Mini, with a Cloudflare Tunnel
exposing it. Good for an always-on self-host on hardware you already own.

## Why a Mac mini (residential egress)?

**This is the recommended production deployment.** A cloud/datacenter deployment
(AWS/GCP/Azure) loses to a plain residential webfetch on Cloudflare/anti-bot-protected
sites (Notion, cppreference, npmjs, Cursor) — those sites challenge **datacenter ASNs**,
and captatum cannot bypass that in code (the egress IP is the lever, not the fetcher).
A Mac mini on a home ISP egresses from a **residential IP** that those sites do not
challenge, so captatum wins where the cloud deploy loses — with **no code change and no
paid proxy**. See [`docs/deployment-egress.md`](../docs/deployment-egress.md) for the
full analysis + evidence.

**Step 0 — verify the host's IP is clean before you migrate:**

```sh
curl -sI https://www.npmjs.com/package/react               # expect 200, not a challenge
curl -sI https://en.cppreference.com/w/cpp/algorithm/ranges/sort
curl -sI https://qogita.notion.site/                       # any notion.site page
```

If any returns a Cloudflare challenge (`403`/`503` + challenge body), the host's IP is
flagged (some ISPs use CGNAT/business ranges) and the residential benefit won't apply.
A typical home ISP IP passes.

## 1) Docker + repo

```sh
brew install --cask docker          # then launch Docker.app
git clone https://github.com/acartag7/captatum.git ~/captatum
cd ~/captatum
node --no-warnings scripts/gen-oauth-keys.ts   # print OAuth keys
cp .env.example .env               # fill it in (keys + Cloudflare + origins)
```

## 2) cloudflared tunnel

```sh
brew install cloudflared
cloudflared tunnel login                          # pick your domain's zone
cloudflared tunnel create captatum                # -> a tunnel UUID + creds JSON
# Route your hostname to the tunnel, then map it to the local gateway:
cloudflared tunnel route dns captatum captatum.your-domain.com
```

Run the tunnel (e.g. via `launchctl` / pm2 / the Cloudflare dashboard as a remote-managed tunnel):

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml run captatum
# config.yml maps captatum.your-domain.com -> http://localhost:3000
```

Create the **Cloudflare Access** app on `captatum.your-domain.com`, scoped to a
policy that holds the consent identity on `/oauth/authorize*`, and put its
`CF_ACCESS_*` values in `.env`.

## 3) Start the stack

```sh
CAPTATUM_TAG=<release-tag> docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f gateway
```

The gateway binds `127.0.0.1:3000`; `cloudflared` reaches it locally. The SQLite
file persists in the `captatum-data` volume.

## 4) Keep it running

Use `launchd` (or Docker Desktop's "Start on login") to run both `cloudflared` and
`docker compose` on boot. Verify:

```sh
curl -sf https://captatum.your-domain.com/healthz   # -> {"status":"ok"}
```

## 5) Reference configs (copy-paste)

### `~/.cloudflared/config.yml` (maps the hostname → the local gateway)

```yaml
tunnel: <TUNNEL-UUID>                # from `cloudflared tunnel create captatum`
credentials-file: /Users/you/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: captatum.your-domain.com
    service: http://localhost:3000
  - service: http_status:404
```

### `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist` (run on boot)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cloudflare.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string><string>/Users/you/.cloudflared/config.yml</string>
    <string>run</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/cloudflared.err.log</string>
</dict>
</plist>
```

Load it: `launchctl load ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`.

### `.env` (the gateway — copy from `.env.example`)

The required vars (all in `.env.example`): `CAPTATUM_FLAVOR=hosted`, the OAuth signing
keys (from `scripts/gen-oauth-keys.ts`), Cloudflare Access (`CF_ACCESS_*`), and
`MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`. Generate
`CAPTATUM_PROXY_AUTH_SECRET` as described in `deploy/README.md` and configure the
hostname-scoped Cloudflare rule to **Set static** `X-Captatum-Proxy-Auth` to the
same value. Docker Compose overrides `CAPTATUM_TRUSTED_PROXY_CIDRS` with its
pinned bridge gateway (`172.29.255.249/32`); do not replace it with loopback,
because host-published traffic does not arrive as container loopback.
`docker compose` reads `../.env` relative to `deploy/`. The SQLite store +
browser sidecar need no extra config (defaults).

### Cutover from an existing managed deployment

The inbound trust boundary is identical (tunnel + Access on `/oauth/authorize*`),
so cutover is: (1) stand up this host's stack; (2) repoint the tunnel/DNS hostname
from the previous deployment to this host; (3) verify `/healthz` + a challenge site
(`curl -sI https://www.npmjs.com/package/react` → 200). Connectors keep the same URL —
no client-side change. Existing OAuth tokens re-issue on first reconnect (one-time; a
fresh store starts empty).
