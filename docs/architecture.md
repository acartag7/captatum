# Architecture

Status: v1 direction. The guarded egress primitive, Tier-1 extraction,
adapter registry seam, gated Tier-3 render, OAuth state stores, hosted OAuth
route/use-case slice, Transform router, hosted Streamable HTTP MCP server, and
the self-contained local stdio bridge are implemented. This document describes
the approved shape. `docs/contracts.md` is the source of truth for tool I/O,
ports, provenance, OAuth, and errors; this file does not duplicate it.

## Shape

Two deployment flavors off **one core engine**:

- **Hosted remote server runtime**. Streamable HTTP `POST /mcp` +
  gateway-owned OAuth, on Node 24 native TS. This repo ships the runtime and
  local authenticated tests/smoke; public deployment packaging, container
  publishing, container-orchestrator wiring, and tunnel routing are outside this repo slice.
  When deployed, this is the flavor web agents use because they cannot use a
  stdio bridge.
- **Self-contained local binary**. The same engine compiled (Bun `--compile`)
  into one executable an agent runs locally — no deployment, **no auth**,
  single-user/single-agent. `wreq-js` native prebuilts bundle alongside.

Auth is conditional on flavor, not on code path: the engine is identical; the
local-binary flavor simply runs without an auth port.

## Layers

- `src/domain`: tool contract types, provenance records, and pure policy. No
  infrastructure imports.
- `src/application`: `ports/` + `use-cases/` + `queries/`. Depends on ports, not
  concrete adapters.
- `src/infrastructure`: concrete adapters behind ports (`wreq/`, `playwright/`,
  `sqlite/`, `tidb/`, `llm/`, `<platform>/`).
- `src/interfaces`: HTTP + MCP entrypoints. Hosted MCP lives at `POST /mcp` with a fresh stateless SDK transport per request.
- `src/config.ts`: centralized configurable values.
- `src/dev`: local checks and scaffold smoke tests.
- root `src/*.ts`: CLI/compat entrypoints.

Domain code must not import infrastructure. Application code depends on ports,
not concretes.

## Port contracts

- **`FetcherPort`** — the single hardened egress.
  `fetchGuarded(url, opts) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`.
  Every outbound request — Tier-1, Tier-2 adapter, every redirect hop, every
  Tier-3 in-browser request — routes through it. This is where the rebinding-proof
  SSRF invariants live.
- **`PlatformAdapter`** + registry — optional known-platform short-circuit.
  `{ id, detect(ctx), resolve(input, fetcher) }`, registered in
  `src/application/adapters.ts`. Adding a platform = one folder under
  `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of
  the public contract.
- **`StorePort`** — OAuth state only (auth codes + refresh tokens, hashed). The
  hosted flavor uses **`node:sqlite`** in a private state directory and supports
  one gateway replica. Captatum keeps OAuth state and DCR/machine-client state in
  separate SQLite files. The local-binary stdio bridge has no OAuth and opens
  neither store.
- **`ModelRouterPort`** — `pick(task, inputTokens, options?): { provider, model?, free?, reason? }` +
  `feedback(model, score)` for a deterministic per-model EMA. `options.localOnly`
  is used when fetched content has sensitive/non-public signals. Implemented by
  `src/infrastructure/llm/model-router.ts`.

## Adaptive pipeline

```text
captatum(url, { prompt?, output?, schema?, budget?, transform?, maxBytes?, timeoutMs?, allowRender? })
  0. guardedFetch(url)                 ← the ONLY egress primitive (rebinding-proof SSRF)
  1. TIER-1  wreq-js fetch (TLS fingerprint, anti-bot) + raw-HTML/JSON-LD extraction + shell-gate
  2. TIER-2  [optional] platform adapter short-circuit (clean JSON via public API)
  3. TIER-3  Playwright render (lazy dynamic import) → extract (gated by allowRender, default false)
  4. TRANSFORM  OpenRouter/Ollama summarize|extract via the model router (only for summary/extract)
  → raw (default, no provider) | summary (default with provider) | extract + provenance
```

- **Tier-1** is `wreq-js` (Rust-powered browser TLS/JA3+JA4 fingerprint
  impersonation → anti-bot/Cloudflare bypass). Raw-HTML extraction reads JSON-LD,
  Open Graph/twitter meta, canonical, and embedded app state
  (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. A
  shell-gate decides real content vs. empty SPA shell.
  **Known P1 limitation:** the guarded requester uses `wreq-js` only for plain
  HTTP. HTTPS delegates to the Node requester so the adapter can connect to the
  checked IP while preserving original-host SNI/certificate verification. That
  keeps the SSRF invariant but means `wreq-js` TLS/JA3+JA4 anti-bot behavior is
  not active for HTTPS until a checked-IP + original TLS identity path is proven
  through `wreq-js`.
- **Tier-2** adapters resolve via a platform's public API when detected. Optional
  and general; endpoints live in adapter code/fixtures. **Shipped: ATS list-all-jobs**
  (Greenhouse/Lever/Ashby) — a career-board URL on an ATS host is detected, the board
  token is sanitized (fail-closed slug charset), and the public list API is fetched
  through `FetcherPort` (SSRF-safe) and normalized to a bounded roster envelope
  (`{platform, board, jobCount, truncated, jobs[]}`, descriptions dropped). On no
  detection or any failure, the request falls through to the generic Tier-1 path.
- **Tier-3** renders with Playwright when Tier-1 finds an empty SPA shell or no
  usable structured data (client-rendered React/Vue/Svelte, JS-only docs/demos,
  anti-bot interstitials, embedded third-party widgets). Gated by `allowRender`
  (default **false**) so a bare `captatum` never spawns a browser. The
  adapter uses lazy `import('playwright')`, disables Service Workers, blocks
  downloads, closes WebSockets, routes document/script/fetch/XHR/style requests
  through `FetcherPort`, checks blocked body types with the same P1 URL/DNS
  private-IP guard before aborting them, and returns `page.content()` to the
  Tier-1 extractor with tier-3 provenance.
- **Transform** is the output path for `output: summary`/`extract`: resolved
  content → token-efficient answer to `prompt` via the free-model router. Configure
  `OPENROUTER_API_KEY`/`OPENROUTER_MODELS` or `OLLAMA_BASE_URL`/`OLLAMA_MODEL`.
  The **default output is provider-conditional**: `summary` when a provider is
  configured, `raw` (no transform) otherwise — so a missing provider no longer
  silently degrades a default summary into a truncated excerpt. Requesting
  `summary` explicitly with no provider still degrades to `raw` with
  `transform: { provider: "none", reason: "unconfigured" }`.

## Hosted MCP server

`src/interfaces/http/app.ts` composes Fastify, `/healthz`, hosted OAuth routes,
and the MCP route. `src/interfaces/http/mcp-route.ts` authenticates every
`POST /mcp` before SDK dispatch, creates a fresh stateless
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`) and a fresh MCP server for that request, and enables
SDK Host/Origin DNS-rebinding protection. Hosted mode requires explicit
`MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, and an exact
`CAPTATUM_TRUSTED_PROXY_CIDRS` socket-peer allowlist. Fastify ignores forwarded
client addresses from any other peer, so OAuth rate-limit identities are neither
globally collapsed behind the tunnel nor caller-selected. `GET`/`DELETE /mcp`
return 405. Tool registration is in
`src/interfaces/mcp/`; the tool schema has `additionalProperties: false`, and the
default output is provider-conditional (`raw` with no provider, `summary` with one).

Scope enforcement happens after authentication and input validation, before the
core engine runs: an effective `output: raw` requires `fetch:read` even when it
carries an unused transform override; summary/extract require `fetch:transform`.
Tool results mirror the shared `Result` as MCP `structuredContent` and include a
model-visible provenance line in the text content. Tool calls write metadata-only
audit events.

## Self-contained local binary

The local-binary flavor is the **same engine** with a stdio transport instead of
HTTP — no second implementation. `src/interfaces/mcp/local-server.ts`
(`createLocalMcpServer`) builds the exact MCP server the hosted `POST /mcp` route
serves (`createCaptatumMcpServer` → the same `captatum` tool schema and the
same P3 `CaptatumUseCase`), but with single-user local auth resolved through
the existing `RequestAuthorizer` (`flavor: "local-binary"` returns the local
subject with both scopes; no OAuth secrets, no token verification). It imports no
hosted-only auth code into the core use case.

`src/interfaces/mcp/stdio-bridge.ts` is the runnable entrypoint: it composes the
real infrastructure (guarded `wreq` fetcher, extractor, model-router transformer,
Playwright renderer), attaches an `StdioServerTransport`, and serves the local
server. Invariants:

- **No network listener.** The bridge opens no port and imports no HTTP server.
  `assertLocalFlavor` makes it **fail loudly** if pointed at the `hosted` flavor,
  so the unauthenticated local path can never become network-exposed. The guard is
  symmetric on the HTTP side: `assertHostedFlavor` (in `src/interfaces/http/app.ts`,
  called by both `createHttpApp` and the `src/server.ts` listener entrypoint)
  **refuses to build or listen** under the `local-binary` flavor, so the network
  `/mcp` listener can never serve the no-auth local flavor (defaults included).
- **stdout is the JSON-RPC channel.** All audit/log output goes to **stderr**.
  The advertised client command is the bare node invocation
  `node --no-warnings src/interfaces/mcp/stdio-bridge.ts`, **not** `pnpm run bridge`:
  pnpm writes a lifecycle banner (`> captatum@… bridge`) to stdout and would
  corrupt the protocol stream. If a package script is required, silence pnpm with
  `corepack pnpm --silent run bridge`. `src/dev/smoke-stdio-process.ts` launches the
  advertised node command and fails if any stdout line is not valid JSON-RPC.
- **SSRF still applies.** Every fetch routes through the same `guardedFetch`
  primitive; guarded-fetch rejections produce the same contract-shaped
  `FETCH_REJECTED` result as hosted mode. "Local" is not permission to skip SSRF.

Run under Node with `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` — the
stdio-safe command MCP clients should spawn (a bare process whose stdout carries
only JSON-RPC). Do not use `pnpm run bridge` as the client command, since pnpm's
lifecycle banner contaminates stdout; use `corepack pnpm --silent run bridge` if a
package script is unavoidable. Build the single-file binary with
`pnpm run build:binary`, which uses Bun's `--compile` (an **external tool**, not
an npm dependency). When Bun is unavailable the script exits non-zero with the
exact `bun build … --compile --outfile dist/captatum` command to run on a
machine that has Bun, and it never claims success unless `dist/captatum` was
actually produced. Packaging caveats: `wreq-js` ships native prebuilts and
Playwright is a lazy `import('playwright')`, so the compiled binary still relies
on those runtime assets being resolvable on the host (see `docs/dependency-ledger.md`).

## Smoke and contract fixtures

`pnpm run smoke` is deterministic and public-network-free. It is split into:

- `pnpm run smoke:hosted` — exercises raw safe fetch, summary via a fake local
  transformer (provider-conditional default), blocked SSRF, render-disabled default behavior, and an
  authenticated hosted `POST /mcp` tool call.
- `pnpm run smoke:local` — exercises the same raw safe fetch use case through
  the local stdio MCP server, then launches the advertised stdio bridge process
  and checks stdout is pure JSON-RPC.

Stable contract examples live in `test/fixtures/contracts/*.json` and are
compared against runtime output by `test/contract-fixtures.test.ts`. The SSRF
payload list lives in `test/fixtures/security/ssrf-payloads.json` and is
exercised by `test/ssrf-fixtures.test.ts`.

## OAuth flow (hosted flavor only)

Applies only to the hosted flavor; the local-binary flavor has no auth. Mirrors
`personal-memory-gateway`. `docs/contracts.md` §OAuth is the canonical reference.

```text
authorize (PKCE S256, request-bound signed consent token)
  → approve  (single-use code, stored as sha256(code); 302 ?code=&iss=&state=)
  → token    (verify PKCE; issue ES256 JWT access token signed by OAUTH_SIGNING_PRIVATE_JWK,
              aud=resource; rotating refresh tokens stored as sha256(raw), grouped by family;
              replay revokes the family)
```

Auth-code TTL 300 s; access TTL 600 s; refresh TTL 30 days. Hosted production
requires `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (fail-fast
at boot). Scopes: `fetch:read` (default), `fetch:transform`; effective raw needs
`fetch:read` (an unused transform override is ignored) and summary/extract needs
`fetch:transform`. `docs/threat-model.md` covers auth limits.

## Rebinding-proof SSRF invariants

The single egress primitive (`FetcherPort` / `guardedFetch`) holds these
invariants; `docs/threat-model.md` is the security reference.

- scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs.
- resolve → `isPrivate` CIDR (exhaustive — see threat model) → connect to the
  **resolved IP** (`node:https` with `servername`/`Host` = original host).
- manual redirects re-validated each hop (`maxHops=5`).
- decompressed-byte cap; `AbortController` timeout.
- Tier-1 `wreq-js` egress lives behind this guard. It must receive the already
  validated connection target; direct `wreq-js` fetches are not a safe substitute.
  Current guarded Tier-1 HTTPS requests intentionally use the Node fallback above
  rather than weakening checked-IP connect semantics.
- Tier-3 in-browser: `page.route` guards every browser request; document/script/
  fetch/XHR/stylesheet requests are fulfilled only through `FetcherPort`;
  image/font/media/analytics URLs are P1 URL/DNS private-IP checked and aborted;
  WebSockets are closed; Service Workers off; downloads blocked; render-byte cap;
  browser in a separate child process with no env; OS sandbox on (never
  `--no-sandbox`).

## File Size Rule

TypeScript source files must stay at or below 250 lines:

```bash
pnpm run check:lines
```

Split by layer or responsibility when a file gets close to the limit.

## Not Implemented Yet / Outside This Repo Slice

- Public deployment packaging/infrastructure wiring is still outside this repo
  slice. The hosted Streamable HTTP MCP runtime exists locally and in tests.
- The SQLite `StorePort` implementation is tested, but the local stdio runtime
  does not currently use it because local mode has no OAuth state.
- Local-binary stdio behavior is complete and exercised by `pnpm run smoke` and
  `pnpm test`. The single-file binary build (`pnpm run build:binary`) depends on
  the external Bun toolchain; on a machine without Bun it exits with the exact
  command to run elsewhere rather than producing a fake artifact.
