# Self-hosting Captatum (hosted flavor)

Captatum's **hosted flavor** is a Streamable-HTTP MCP server (`POST /mcp`) with
gateway-owned OAuth, reachable from web agents (claude.ai, chatgpt.com). This guide
covers the **common setup** and three one-click targets: **Railway**, **EC2**, and
**Mac Mini + Cloudflare**.

The common setup is intentionally dependency-light:

- **State**: two local SQLite files on one volume — OAuth state at
  `CAPTATUM_SQLITE_PATH` and clients at the derived `<path>.clients` companion.
  v0.20.x supports exactly one gateway replica; any TiDB configuration is
  rejected at boot.
- **Auth**: gateway OAuth **+ Cloudflare Access** in front of the consent screen.
- **Tier-3 rendering**: a separate **browser sidecar** container (blast-radius
  separation — a browser compromise never reaches OAuth keys / the SQLite files).

```
                 Cloudflare Access (consent identity)
                          │  Cloudflare Tunnel
                          ▼
   ┌──────────────────────────────────────────────┐
   │ captatum gateway  (OAuth keys, SQLite files)  │  127.0.0.1:3000
   │       │ CDP                                    │
   │       ▼                                        │
   │ captatum-browser (Chromium, no secrets)       │
   └──────────────────────────────────────────────┘
```

## 1. Required secrets

Copy `.env.example` to `.env` and fill it in.

Generate the OAuth signing material once (prints export-ready env lines):

```sh
node --no-warnings scripts/gen-oauth-keys.ts
# -> OAUTH_SIGNING_KEY_ID, OAUTH_SIGNING_PRIVATE_JWK, OAUTH_CONSENT_SIGNING_SECRET
```

Set the deploy-specific values:

- `OAUTH_ISSUER`, `OAUTH_RESOURCE` — your gateway's public origin (e.g.
  `https://captatum.your-domain.com`). `ISSUER` and `RESOURCE` are usually equal.
- `OAUTH_REDIRECT_ALLOWLIST` — exact connector origins (e.g.
  `https://claude.ai,https://chat.openai.com`). Never `*`.
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` — the public host/origin(s) clients
  reach (inbound DNS-rebinding protection).
- `CAPTATUM_TRUSTED_PROXY_CIDRS` — exact IP/CIDR allowlist of the reverse-proxy
  socket peer(s) allowed to supply client IPs for OAuth rate limits. Docker
  Compose pins and supplies its host-bridge peer. Do not trust all proxies or a
  whole private range.
- `CAPTATUM_PROXY_AUTH_SECRET` — exactly 32 random bytes encoded as 43 base64url
  characters. Generate it with
  `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`.
  In Cloudflare, create a Request Header Transform Rule scoped to the Captatum
  hostname that uses **Set static** (overwrite) for
  `X-Captatum-Proxy-Auth` with the same value. The gateway removes the header
  from parsed and raw header views before route dispatch. A missing/wrong value
  rejects forwarded address, host, protocol, and port headers, so a browser
  sidecar sharing the socket peer cannot select rate-limit or framework
  authority.
- `CAPTATUM_SQLITE_PATH` — the OAuth-state SQLite path. Its parent is Captatum's private state directory and must be owned by the gateway user at mode `0700`; both database files must be `0600`. Captatum derives the client store as `<path>.clients`, so both land on the same mounted volume without sharing a database file or write lock. The image prepares `/data` as `node:node`/`0700`, including fresh named-volume initialization; for an existing bind mount, run `chown <gateway-uid>:<gateway-gid> /data && chmod 0700 /data` on the host before boot. Set the path to `/data/captatum.sqlite` as the templates do.

## 2. Cloudflare (Access + Tunnel)

The hosted flavor **requires Cloudflare Access** (it fail-closes at boot without
`CF_ACCESS_ENABLED=true` + audience/certs/issuer):

1. **Cloudflare Tunnel** (`cloudflared`) from your host to `127.0.0.1:3000`, exposing
   your public hostname (e.g. `captatum.your-domain.com`).
2. **Cloudflare Access application** on the tunnel hostname, scoped to a policy that
   holds the consent identity (e.g. an email allowlist) on `/oauth/authorize*`.
3. Put the Access app's **AUD**, **issuer** (`https://<team>.cloudflareaccess.com`),
   and **certs URL** (`.../cdn-cgi/access/certs`) into the `CF_ACCESS_*` env vars.
4. Add the hostname-scoped **Set static** request-header rule described above.
   Never use append semantics: an inbound caller value must be overwritten.

## 3. Targets

| Target | Guide | Notes |
| --- | --- | --- |
| **Railway** | [`railway.md`](./railway.md) + `railway.toml` | One gateway service from the published image + a `/data` volume. **Tier-3 needs the browser sidecar in the gateway's network namespace** (CDP is loopback-only) — so on Railway run gateway + sidecar in ONE service, not a separate one (a second service can't reach `127.0.0.1:9222`). |
| **EC2** | [`ec2-user-data.sh`](./ec2-user-data.sh) | cloud-init: installs Docker and runs `docker compose up -d` with the gateway + sidecar. |
| **Mac Mini** | [`mac-mini.md`](./mac-mini.md) | `cloudflared` + `docker compose` on macOS. |

All three use the same `docker-compose.yml` and the same `.env`, so the setup is
identical apart from how the host is provisioned and how `cloudflared` is run.

## Verifying

```sh
curl -sf https://captatum.your-domain.com/healthz   # -> {"status":"ok"}
```

Then register the MCP server in your client (claude.ai / ChatGPT connector) with the
public origin and complete the OAuth consent flow (fronted by Cloudflare Access).
Stored DCR registrations use the same SQLite volume and survive restarts.

For a headless service, manage machine credentials from the gateway container.
There is deliberately no HTTP provisioning endpoint:

```sh
docker compose -f deploy/docker-compose.yml exec gateway \
  node --no-warnings src/machine-client.ts provision nightly-fetch fetch:transform

docker compose -f deploy/docker-compose.yml exec gateway \
  node --no-warnings src/machine-client.ts rotate <clientId> 300

docker compose -f deploy/docker-compose.yml exec gateway \
  node --no-warnings src/machine-client.ts disable <clientId>

docker compose -f deploy/docker-compose.yml exec gateway \
  node --no-warnings src/machine-client.ts list
```

Provision and rotate print one JSON credential result to stdout exactly once,
after the client row and required audit commit atomically. Capture it directly
into the caller's secret manager; audits and diagnostics go to stderr and contain
neither the secret nor its hash. If stdout delivery fails or short-writes after
commit, the CLI attempts a compensating disable and exits non-zero; `list` shows
the tombstone when that succeeds. If compensation fails, use `list` then
`disable` before provisioning a replacement. A close failure after successful
delivery is reported on stderr and exits non-zero without suppressing or
repeating the valid credential.
Rotation overlap defaults to 300 seconds and cannot exceed 600 seconds.
Provisioned scopes are a fixed ceiling and must be a non-empty subset of
`fetch:read` / `fetch:transform`.

## Scaling beyond a single instance

v0.20.x is intentionally single-replica SQLite. Multi-replica operation is
unsupported. The deferred TiDB path requires an explicit data transfer,
distributed mutation serialization, bounded retention, and real multi-replica
acceptance tests before it can return. See `docs/contracts.md` "Storage".

## Troubleshooting

The gateway boot **fails closed** on any missing required secret — by design. Logs
go to stdout as JSON: `docker compose -f deploy/docker-compose.yml logs -f gateway`.

| Symptom | Cause / fix |
| --- | --- |
| `HostedFlavorError` / container exits at boot | Set `CAPTATUM_FLAVOR=hosted` (the compose file sets it; if you bypass `.env`, ensure it's present). |
| Boot aborts "Hosted requires …" | A required secret is missing: `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (`gen-oauth-keys.ts`), all four `CF_ACCESS_*`, `MCP_ALLOWED_HOSTS` + `MCP_ALLOWED_ORIGINS`, the exact `CAPTATUM_TRUSTED_PROXY_CIDRS` peer allowlist, or `CAPTATUM_PROXY_AUTH_SECRET`. |
| Public requests return `invalid_proxy_auth` | The Cloudflare hostname rule is missing/mismatched. It must **Set static** `X-Captatum-Proxy-Auth` to the same secret as the gateway; do not expose or log the value. |
| `summary` returns raw (`transform.provider: "none"`) | No transform provider: set `OPENROUTER_API_KEY` (or `OLLAMA_BASE_URL`). **Or** the caller's token lacks the `fetch:transform` scope (default `fetch:read` only allows `raw`). |
| Tier-3 `render-unavailable` | The gateway can't reach the browser sidecar. `CAPTATUM_BROWSER_CDP_ENDPOINT` must be `http://127.0.0.1:9222` and the sidecar must share the gateway's network namespace (`network_mode: service:gateway` in compose). |
| `~/.env` not picked up | compose `env_file` is `../.env` (repo root), and `environment:` overrides it — set secrets in `.env`, flavor/host/CDP via compose. |

## Upgrading

Pull a newer `CAPTATUM_TAG` and recreate: `docker compose -f deploy/docker-compose.yml up -d`.
OAuth state and stored client registrations persist in the `captatum-data` SQLite
volume. The first upgrade from stateless DCR invalidates old stateless client IDs;
interactive clients re-register once, then survive later restarts. Re-running
`gen-oauth-keys.ts` rotates the signing key and **invalidates all previously issued
tokens** (every client must re-authorize).
