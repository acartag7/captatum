# Contracts

Tracks the public and internal contracts for captatum. Update this file **before** changing any tool, port, schema, endpoint, or error shape. v0: fields may be added freely; renaming or removing a field is a breaking change and must be noted here.

## Versioning

Current contract version: `v0`.

### Breaking changes

- **v0.9.0:** (1) `access.gateReason: "login"` is renamed to `"js-required"` — captatum never actually detected login walls; "login" was the catch-all for *render-needed* pages, now labeled honestly. (2) `allowRender` defaults to `true` (hosted auto-renders JS-shell pages; was `false`). A consumer keying on `gateReason === "login"` must switch to `"js-required"`.
- **v0.20.0:** hosted DCR changes from stateless to stored. Pre-v0.20.0
  interactive `client_id` values are deliberately invalidated and those clients
  must register once again. Before the new server listens, a durable one-time
  migration atomically deletes every pre-upgrade authorization code and refresh
  family. Captatum also derives a v0.20 stored-DCR-specific consent/flow signing
  key from the configured consent secret, so browser-held pre-upgrade consent
  and upstream-flow tokens fail signature verification instead of minting a new
  legacy authorization code. Every stored-DCR authorization code, refresh
  family, and refresh-token row is additionally bound to mcp-sso's durable
  generation `1`. A rolled-back pre-v0.20 binary omits the nullable generation
  columns, so grants it creates are legacy `NULL` rows; after re-upgrade,
  authorization-code consumption, refresh rotation, and prior-scope
  accumulation reject those rows even when their `client_id` names an existing
  stored client. Genuine generation-1 sessions survive ordinary v0.20
  restarts. Access tokens already issued by v0.19.1 expire naturally within
  their 600-second TTL. This is additive for a new machine client such as
  application-agent, but it is a breaking re-registration event for existing
  interactive clients. The v0.20.0 stored-DCR release supports one hosted
  replica with SQLite only; a configured TiDB backend is rejected at boot until
  the later scale release supplies an explicit SQLite-to-TiDB transfer,
  distributed mutation serialization, and real multi-replica tests.

## Product

Captatum is the web read an agent can trust: one MCP tool that fetches **any** URL and returns clean, **token-efficient** content plus a **provenance receipt** on every response (tier, final URL, whether JS was required, transform model/tokens) so an agent knows exactly how each result was produced. Every request is **SSRF-guarded**, and fetched content is treated as **untrusted data, never instructions**. The wedge is **trustworthy reads** — clean content from the JS-rendered SPAs and structured pages other tools return empty or blocked.

The **default output is provider-conditional**: `summary` (via the free-model router — OpenRouter/Ollama) when a transform provider is configured (e.g. the hosted server), otherwise `raw` (full clean content, no LLM) — so a zero-config call returns real content instead of silently degrading to a truncated excerpt. `output: "raw"` returns clean resolved content + parsed structured data; `output: "extract"` returns JSON shaped to a caller schema.

Unlike `WebFetch` (static GET + Turndown, which drops `<script>` JSON-LD/app-state and runs no JS) and render-only services (Firecrawl/Jina strip structured data and give no receipt), captatum uses anti-bot TLS-fingerprinted fetch (`wreq-js`), renders JS only when a page needs it, extracts structured data (JSON-LD / Open Graph / meta) from raw HTML, and reports provenance on every response. Anti-bot challenge walls (Cloudflare/Akamai/PerimeterX/DataDome/Imperva, plus generic browser-verification interstitials) over HTTPS it **detects and reports as gated** (`gateReason: captcha` when a vendor is attributable, `bot_verification` for a generic 429/503 verification wall); it does **not** bypass them.

## Protocol

- MCP protocol: support `2025-11-25` clients; **write the server in the `2026-07-28` RC style where the pinned SDK permits** (stateless, self-contained requests), mirroring `personal-memory-gateway`'s investigation. Do not depend on sessions or `initialize` for security.
- Compatibility note for the pinned `@modelcontextprotocol/sdk@1.29.0`: its latest supported protocol is `2025-11-25`, not the forward `2026-07-28` RC. The hosted server therefore implements the compatible forward pieces only: fresh server + fresh Streamable HTTP transport per `POST /mcp`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`, per-request bearer auth before MCP dispatch, and no `MCP-Session-Id` auth. SDK features not exposed in this pin, such as `server/discover` and `subscriptions/listen`, are not implemented yet. SDK 1.29.0 also requires clients to send an `Accept` header that includes both `application/json` and `text/event-stream`.
- Transport: **Streamable HTTP** at `POST /mcp` (stateless: fresh transport per request, `sessionIdGenerator: undefined`, `enableJsonResponse: true`). `GET/DELETE /mcp` → 405.
- `GET /healthz` is the only unauthenticated route → `{ status: "ok" }`.
- Every `/mcp` request is authenticated and authorized independently. Session IDs are never auth.
- **Server request timeout** (`Fastify requestTimeout`): bounds REQUEST-BODY receipt only (a slow client streaming a huge body), NOT handler/tool time. The `/mcp` handler calls `reply.hijack()` for Streamable HTTP, which decouples Fastify's request timers — so this is NOT a backstop for tool execution. Tool execution is bounded by its OWN per-tier `timeoutMs` (single-fetch) and the bulk `maxGlobalWallMs` wall, both enforced inside `execute()` via `AbortController` (the #148 partial-return works through that AbortController, not through this server option). A handler-level deadline wrapping the MCP transport itself is a documented future defense-in-depth.
- The repo ships two runtime entrypoints over the same core engine. The hosted
  Streamable HTTP server is implemented locally and covered by authenticated
  route/smoke tests; public deployment packaging/infrastructure is outside this
  repo slice. When deployed with OAuth, that hosted HTTP flavor is the path web
  agents can use. The local **stdio bridge**
  (`src/interfaces/mcp/stdio-bridge.ts`) is the self-contained local-binary
  entrypoint: it runs the **same** core engine in-process over an
  `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`) for a
  single local agent. It has **no OAuth**, opens **no network listener**, and is
  **not** a remote proxy. It reuses the hosted `captatum` use case and tool
  schema unchanged (`src/interfaces/mcp/local-server.ts` builds the same MCP
  server the `POST /mcp` route serves, with single-user local auth). It refuses
  to start under the `hosted` flavor (fails loudly rather than exposing an
  unauthenticated surface), and all logs go to stderr so stdout stays the
  JSON-RPC channel. It does not serve web agents — they require the hosted HTTP
  server.
- Auth is conditional on deployment flavor (see OAuth / Deployment): the hosted flavor requires gateway OAuth bearer tokens; a self-contained local-binary flavor runs without auth.
- Inbound Host/Origin DNS-rebinding protection via the SDK transport (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). Hosted boot requires explicit `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, the exact reverse-proxy socket-peer allowlist `CAPTATUM_TRUSTED_PROXY_CIDRS`, and the 32-byte base64url proxy authenticator `CAPTATUM_PROXY_AUTH_SECRET`; local defaults are loopback-only.
- **Discoverability:** the `captatum` tool `description` advertises every output mode (summary/raw/extract), provenance, `allowRender`, and `debug`, and the MCP server sends `instructions` on `initialize` (a capability guide for clients/agents). Both shapes share `createCaptatumMcpServer`, so both expose the same description + instructions. The two-shapes decision (hosted primary, local binary retained) is recorded in `docs/two-shapes.md`.

## Tool: `captatum`

One tool. Input (v0):

| Field | Required | Notes |
| --- | --- | --- |
| `url` | yes | Fully-formed `http`/`https`. `http` upgraded to `https`. No userinfo. |
| `prompt` | no | What the caller wants from the page (drives `summary`/`extract`). Mirrors WebFetch. Defaults to a general summary. |
| `output` | no | `raw` (default with no provider) \| `summary` (default with a provider) \| `extract`. `summary` = token-efficient answer via the Transform router. `raw` = clean resolved content, no LLM. `extract` = structured JSON per `schema`. The default is **provider-conditional**: `summary` when `OPENROUTER_API_KEY`/`OLLAMA_BASE_URL` is set, else `raw`. |
| `schema` | no | JSON schema for `output: extract`. For client compatibility, only root `budget`, `timeoutMs`, `allowRender`, `debug`, `maxBytes`, and `transform` accidentally merged here are revalidated and removed before schema validation. A valid nested value applies only when its actual top-level peer is absent; otherwise it is discarded and a value-free `schema_knob_extracted` warning records the precedence. Every other unsupported key rejects before egress. |
| `budget` | no | Max output tokens for `summary`/`extract`. When omitted the server applies a default (`TRANSFORM_MAX_OUTPUT_TOKENS`, default 8000) and clamps any explicit value to the **chosen model's** max output (#125: deepseek-v4-flash 16 384, qwen3.6-flash 65 536 — not a global 4 K ceiling). If the completion still truncates (`finish_reason=length`) after budget escalation, a non-fatal `transform_truncated` advisory is surfaced. |
| `transform` | no | Override the default router/model/provider: `{ model?, provider?, ... }`. |
| `maxBytes` | no | Response byte cap (decompressed). Default 5 MB, server hard-capped. |
| `timeoutMs` | no | Per-tier wall-clock. Default 15 s (Tier-1/2), 20 s (Tier-3). |
| `allowRender` | no | Default **true**. On hosted (browser available) a JS-shell page is rendered automatically; on a no-browser runtime (local) it reports `render-unavailable`. Set `false` to opt out (Tier-3 skipped, provenance reports `render-blocked`). |
| `debug` | no | Default **false**. When true, the MCP `structuredContent` adds heavy diagnostic fields (`attempts`, `timings`, full `structured` incl. JSON-LD `description`/`articleBody`, `redirects`, `durationMs`, `httpContentType`, `contentSha256`, `provenanceHash`, verbose `transform`). Default payload is lean (see "MCP structuredContent"). |

**Default `output` is provider-conditional** — `summary` (resolved content passed through the Transform router: free-first OpenRouter, or local Ollama → a token-efficient answer to `prompt`) when a provider is configured; otherwise `raw` (clean resolved content, no LLM). This is exactly the role WebFetch's Haiku step plays, but cheaper and fed by accurate rendered/extracted content — and a zero-config call with no provider honestly returns full `raw` content instead of silently degrading to a truncated excerpt. Requesting `output: "summary"` explicitly with no provider still falls back to `raw` (`transform.provider: "none"`). Output is MCP `text` with a provenance line as the first line (HTML-comment-wrapped, always model-visible). For `summary`/`extract`, a **deterministic envelope header** (backend-generated, not LLM) follows the provenance line — `contentType`, `title`, `finalUrl`, `access` (public | gated + reason), `images` count + first URL, `transformModel` — so every client (including ones that surface `content` text but not `structuredContent`) sees the key fields; `raw` output omits it. The companion `structuredContent` is a **lean agent payload** (see "MCP structuredContent"), not the full Result — heavy fields are gated behind `debug`. Token-efficiency signals (`bytes`, `contentType`, `transform.inTokens/outTokens`) let the caller follow up.

**Client-aware shaping (#45).** Some connectors render `content[0].text` but not the full `structuredContent` (e.g. Claude Code), so `debug: true` (which places diagnostics in `structuredContent`) appears to do nothing there. The output shape can be tuned per OAuth `client_id` via the `CAPTATUM_CLIENT_PROFILES` env (`clientId=profile,…`; deployment-specific). The `text-forward` profile appends a compact diagnostics block to `content[0].text` when `debug` is on (for non-raw output — raw stays clean); unknown/local `client_id`s get the **default** profile (= today's behavior), so this is additive + backward-compatible. Registered connector `client_id`s are discoverable from the audit log (`audit.tool` events carry `clientId` per call).

## Tool: `captatum_bulk`

A second, additive tool that runs N independent single-URL `captatum` calls under
hard global + per-host + per-call bounds. **The orchestrator adds NO egress
path** — it composes the single-URL use case per seed; every per-seed SSRF /
Tier-3 / prompt-injection control is enforced unchanged. Amplification factor is
**fixed at 1 per caller-supplied URL**: no sitemap, no link-following, no
recursion, no `depth` field (its absence is the structural anti-crawler
guarantee). Discovery (board→roster, sitemap, crawl-frontier) stays in single-
fetch / a future `captatum_crawl` lane; bulk is strictly per-URL. v1 is
**cross-domain** (one call may span N registrable domains — "compare these
competitor pages"); the directed-DoS bound is the per-host cap (below), not a
same-domain scope restriction.

**Bright line (stated honestly):** captatum never follows links and never
depth-crawls in its GENERIC path. The existing Tier-2 ATS adapter is a built-in,
bounded roster expander (cap 500) for board-root seeds in SINGLE fetch only.
`captatum_bulk` adds NO expansion — it is per-URL only and additionally REJECTS
board-root seeds per-entry. Discovery is a future `captatum_crawl` lane we are
deliberately NOT entering.

Input (v0):

| Field | Required | Notes |
| --- | --- | --- |
| `urls` | yes | Non-empty array of fully-formed `http`/`https` URLs. Each is `http`→`https` upgraded, userinfo/CRLF-stripped (`normalizeContractUrl` per entry). Duplicates (canonicalized) are dropped and counted. |
| `prompt` | no (yes for summary/extract) | Uniform across all seeds. Defaults to a general summary. |
| `output` | no | **DEFAULT `raw`** for bulk (flipped from single-fetch's provider-conditional default). `summary`/`extract` run the Transform router once per seed and drop the URL cap to 10. |
| `schema` | no | Uniform JSON schema for `output: extract`. At the input boundary, root-level `budget`, `timeoutMs`, `allowRender`, `debug`, `maxBytes`, and `transform` accidentally merged into this object are revalidated and removed from a schema clone. A valid nested value becomes the uniform tool argument only when its true top-level peer is absent; otherwise the top-level value wins and the nested value is discarded. Each repair/discard is disclosed once as `schema_knob_extracted`. Every other unsupported keyword is a whole-call `extract_schema_unsupported_keyword` reject before any seed is fetched (#153/#193). |
| `budget`, `transform`, `maxBytes`, `timeoutMs`, `debug` | no | Uniform; same semantics as single-fetch. Bulk `timeoutMs` default **8 s** (per-seed Tier-1/2). |
| `allowRender` | no | **Defaults `false`** (bulk is raw-extraction-first). **`true` is allowed** (render-on-bulk landed in PR 3): a seed that is a true JS shell (`jsRequired`) renders under the same Tier-3 controls as single-fetch. Two PR-3 controls keep it honest: (a) the render's **subresource egress hosts** are fed into the per-host union count gate (`renderEgressHosts` → `hostCounts`), so a render-path directed victim IS bounded by `maxPerHostInBulk` (BULK-3); (b) **deep `egressBytes`** counts the render's subresource bytes (`essentialBytes + bytesFulfilled`) against `maxGlobalEgressBytes` (BULK-5). `maxRenderedSeeds` bounds how many seeds may attempt a render per call. |
| `maxTransformCostUsd` | no | Per-call transform cost ceiling (USD). Caller-set, clamped to the server ceiling `$0.50`. Over-ceiling caller value is clamped + disclosed. |
| `perSeedTransformCostUsd` | no | Per-seed transform cost ceiling (USD). Caller-set, clamped to the server ceiling `$0.05`. Bounds concurrent overshoot. |

**No per-seed overrides in v1** — `prompt`/`output`/`schema`/`transform` apply
uniformly to all seeds. Per-seed `{url,prompt,schema}` is a documented v1.1
forward path (the `urls` element widens `string → string|object`, no schema
break). **No `depth`/`scope` field** — its absence is the anti-crawler guarantee.

### BulkGuard — the caps (cross-domain v1)

The per-call BulkGuard caps bound a SINGLE call. Two further hosted controls
land in PR 3 and bound cross-call amplification (see "Hosted amplification
controls" below): a process-wide `LimitingFetcher` (global fetch-concurrency
cap, BULK-2) and a per-tenant `BulkQuotaPort` (rolling seed-window quota,
BULK-1, fail-closed). Server ceilings are NOT caller-overridable; caller values
for the cost knobs are **clamped** to the ceiling and the clamp is disclosed.
There is no separate `bulk:read` scope in v1 (founder decision 7 — bulk reuses
`fetch:read` / `fetch:transform`); the `BulkQuotaPort` is the per-tenant bound.

| Cap | Default | Attack it bounds |
| --- | --- | --- |
| `maxUrls` | 50 (`raw`) / 10 (`summary`\|`extract`) | unbounded crawl (total across all hosts); over-ceiling → CLAMP + DISCLOSE |
| `maxPerHostInBulk` | 10 | directed DoS — COUNT per victim; **union-keyed on egress hosts** (seed + redirect + finalUrl + Tier-2-resolved); truncate + disclose + quarantine. Worst-case per-victim count is `maxPerHostInBulk + maxConcurrency` (redirect-discovery overshoot; pure-direct is `maxPerHostInBulk` via shaping — see § In-flight discovery overshoot). |
| `maxGlobalEgressBytes` | 100 MB | egress amplification (host-agnostic global sum from `result.egressBytes ?? result.bytes` — deep egress incl. Tier-3 subresource bytes once render-on-bulk is allowed; exact for the raw Tier-1 path) |
| `maxGlobalWallMs` | 55 000 (hosted default; ceiling 180 000) | browser-time / orphaned-call (hard, NOT caller-raisable past the 180 s ceiling). **Tuned to the MCP client tool-call timeout window (#148):** the documented binding constraint is ~60 s — chatgpt.com's hosted MCP connector hard-closes a tool call at ~60 s (HTTP 424) and the Claude Code SDK at 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`); claude.ai's hosted connector is undocumented but observed shorter than Claude Desktop's 300 s (a separate surface). A wall above that produces a partial the client never sees (the prod audit showed 74–137 s bulks finishing after the client had already left → 124 `context canceled` drops). 55 s lands the structured partial inside the ~60 s window — the wall fires inside `execute()` via `AbortController`, independent of the HTTP layer (see Protocol); bulks that finish sooner are unaffected (the wall never fires). Lowering the hosted **default** to 55 s lost no real hosted capability (a partial above the client window is orphaned by definition), but the **ceiling stays 180 s** so the **local-binary flavor** (no client timeout — a patient stdio client) keeps its pre-#148 wall via an operator override (`local-server.ts` falls back to the ceiling), and a hosted deployment may raise toward 180 s via the `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` env knob if it learns its real client timeout is higher (codex #156 P2, #157). At the deadline a global `AbortController` fires: it aborts in-flight Tier-1 fetches via `CaptatumContext.signal` (composed with each fetch's per-tier timeout) AND the orchestrator stops dispatching, marking remaining seeds `bulk_deadline_exceeded`. The signal is also threaded into the Tier-3 render path (PR 3): the `PlaywrightRenderer` closes the page on abort AND every render subresource `fetchGuarded` is composed with it, so an abandoned render is CANCELED (not just un-awaited) — no browser slot or egress lingers past the wall. |
| `maxConcurrency` | 4 | directed DoS — global fetch concurrency (shared across all hosts in a call) |
| `maxRenderedSeeds` | 10 | Tier-3 OOM (count of seeds that may ATTEMPT a render per call). **Active** — counted post-settle over ACTUAL render attempts (a tier-3 attempt trace: success, empty, OR a 4xx/5xx render, all of which spawned a browser). Overshoot ≤ `maxConcurrentRenders` (the renderer's own concurrency cap = the true browser-spawn bound): at most that many renders settle before the count catches up. Past the cap, further `allowRender:true` seeds are downgraded (render-blocked at Tier-1, `bulk_render_cap_exceeded` warning). |
| `maxPerHostInflight` | 2 (CONFIGURABLE) | directed DoS — per-host token-bucket **burst**, keyed on the SEED registrable domain in v1 (the only host known pre-egress — NOT union-keyed); tune empirically |
| `crawlDelayMs` | 1000 (500 floor, server-clamped) | per-host token-bucket **refill** (politeness per victim) |
| `maxTransformCostUsd` | 0.50 (CONFIGURABLE per-call; clamped) | cost amplification — global, re-checked after each transform |
| `perSeedTransformCostUsd` | 0.05 (CONFIGURABLE per-call; clamped) | cost amplification — concurrent-overshoot bound. **Clamped to `maxTransformCostUsd / maxConcurrency`** (disclosed): up to `maxConcurrency` transforms run before the post-transform global re-check, so sizing per-seed to `global / concurrency` keeps the first in-flight wave ≤ the caller's ceiling (the invariant `maxConcurrency × perSeed ≤ maxTransformCostUsd`). A runtime reservation in the budget tracker (PR 2) tightens this further. |

**Operator config (`CAPTATUM_BULK_*`).** The deployment knobs — `CAPTATUM_BULK_ENABLED`,
`CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT`, `CAPTATUM_BULK_CRAWL_DELAY_MS`,
`CAPTATUM_BULK_MAX_CONCURRENCY`, `CAPTATUM_GLOBAL_FETCH_CONCURRENCY`,
`CAPTATUM_BULK_QUOTA_WINDOW_SECONDS`, `CAPTATUM_BULK_QUOTA_SEED_LIMIT` — are operator-only (never
caller-overridable) and sourced from `src/config.ts`. `maxGlobalWallMs` is exposed as
`CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` (#157): a **clean decimal integer of milliseconds in `[1, 180 000]`**
— the **hosted** runtime lever to raise the 55 s default toward 180 s without a code change.
**Unset / empty → the hosted 55 s default.** The **local-binary flavor is unaffected** (it keeps the
180 s ceiling regardless — it does not read this env). **A malformed value — non-numeric, negative,
zero, above the ceiling, or a `Number()` shape the operator did not literally type (hex, scientific
notation, float, signed) — is a BOOT REJECTION, not a silent default**: there is no per-call receipt
that discloses an operator clamp, so boot is the only operator-facing signal, and `value || default`
on this security selector is forbidden. The env is operator/deploy-time (k8s ConfigMap/Secret), not
request input — a remote MCP caller cannot set `process.env`, so the boot rejection is an operator
foot-gun, not a remotely-exploitable DoS. The domain (`resolveBulkGuard`) clamps to the ceiling as
defense-in-depth regardless.

**Cross-domain directed-DoS model.** In same-domain the per-host caps were
politeness to one host; in cross-domain they ARE the directed-DoS bound, and a
redirect-funnel vector appears (N seeds on N distinct domains all 302→victim).
The per-host cap is therefore **union-keyed on egress hosts**: pre-egress it
truncates each SEED registrable domain to `maxPerHostInBulk` (catches dumb
floods); post-egress a running count aborts further seeds to any union host that
crosses the cap (`status:"fail"`, code `bulk_per_host_cap`). The per-host
token-bucket bounds the rate **for known hosts** — an undiscovered redirect victim
is not in the bucket until the first seed settles, so the discovery wave is
bounded separately (see "In-flight discovery overshoot" below). Directed-DoS
*relative to a victim* is inherent to any bulk tool — these caps bound, not
eliminate, it (Known Risk).

**In-flight discovery overshoot (honest bounds).** A victim host is only added
to the union count AND the union-keyed token bucket AFTER a seed settles (the
redirect target is unknown at dispatch). The count cap bounds **seeds touching a
host**, not raw HTTP requests: a single seed's redirect chain (`maxHops=5`) can
hit the same victim more than once (`victim.com/a → victim.com/b`), so the
worst-case per-victim **request** count is the seed count below × `maxHops` — but
that hop factor is bounded by `maxHops` and is the victim's own redirect config,
not attacker amplification (the attacker amplifies via SEEDS, which the seed
count cap bounds). Consequences of the discovery lag, stated honestly:
- **Count (seeds):** the redirect-discovery wave can be up to `maxConcurrency` wide
  (the victim is undiscovered until the first funnel seed settles, by which time up to
  `maxConcurrency` are in flight), so the worst-case per-victim SEED count is
  `maxPerHostInBulk + maxConcurrency` (= 14 at the defaults; pure-direct floods are
  tighter at `maxPerHostInBulk` via shaping, pure-redirect ≈ `+ maxConcurrency - 1`).
  Once a redirect-discovered victim crosses the cap the orchestrator QUARANTINES (stops
  dispatching the rest; in-flight finish). The per-victim REQUEST count is the seed
  count × `maxHops` (victim-controlled redirects). Tightening the direct+redirect mix to
  `+ maxConcurrency - 1` would require quarantining on ANY host reaching the cap
  (including direct), which over-truncates legitimate multi-host bulks — not worth one
  fewer seed at the victim.
- **Rate:** the `maxPerHostInflight` token bucket is keyed on the SEED registrable
  domain (the only host known pre-egress), NOT on the union — so it rate-bounds a
  victim only when the victim IS a seed domain (a direct flood) or a previously-
  discovered funnel source whose seed domain repeats. A pure cross-domain funnel's
  victim (distinct seed domains, all → victim) is NOT rate-bounded by the token
  bucket in v1; its rate is bounded only by the GLOBAL `maxConcurrency` semaphore
  (≤ 4 concurrent), so the discovery wave + all subsequent funnel seeds hit the
  victim at ≤ `maxConcurrency`-wide concurrency with no per-victim crawl spacing.
  True union-keyed rate spacing for undiscovered funnel victims is the documented
  future quarantine/serialize-unknown-egress-dispatch hardening.

Net: a redirect-funnel victim can see a one-time concurrent first-hop burst of ≤
`maxConcurrency` (= 4) and a total of ≤ `maxPerHostInBulk + maxConcurrency`
SEEDS (≤ × `maxHops` REQUESTS — ≤ 14 seeds / ≤ 70 requests at the defaults). Both
are bounded; the quarantine (stop dispatching once a redirect victim is discovered)
is implemented in v1. A future hardening (serialize ALL unknown-egress dispatch
once any seed discovers a victim) bounds the discovery wave too.

**Egress-byte accounting honesty.** `maxGlobalEgressBytes` is summed from
`result.egressBytes ?? result.bytes`. For the raw-default Tier-1 path,
`egressBytes` is the fetched document bytes (== `result.bytes`, exact). For a
Tier-3 render, `egressBytes` is the render's total network egress
(`essentialBytes + bytesFulfilled` — every subresource the browser loaded through
`route.fulfill`), which is HONEST subresource accounting (BULK-5 resolved), not
the rendered DOM size. `result.bytes` stays the document/DOM byte count for
WebFetch-shape compatibility; `egressBytes` is the network-egress truth the cap
sums. A Tier-2 roster short-circuit contributes its `bytes` (one fetch).

**Render subresource hosts in the union (BULK-3 resolved).** When a seed renders,
the browser egresses script/xhr/fetch **subresources** through `fetchGuarded`
whose hosts never appear in the seed's redirect/finalUrl chain. Those hosts are
collected per render (`renderEgressHosts`) and fed into the orchestrator's
post-settle per-host count gate alongside `unionEgressHosts` — so a render-path
directed victim IS bounded by `maxPerHostInBulk` (a seed that renders N
subresources to `victim.com` counts as one seed touching `victim.com`, and the
per-render byte pool — a fixed **48MB essential cap** + a `maxBytes` non-essential cap,
decoupled from `maxBytes` since #143 (heavy SPAs like Notion ship ~19MB of essential JS;
coupling the cap to `maxBytes` aborted their bundles mid-load → `render_empty`) — bounds
the per-render subresource volume).
Combined with `maxRenderedSeeds` (render attempts), the global deep-`egressBytes`
cap, and the `LimitingFetcher` global fetch cap, the render path is bounded on
count, rate, bytes, and concurrency.

**Egress cap in-flight overshoot (honest bound).** The global byte cap is summed
from `result.egressBytes ?? result.bytes` AFTER each seed returns, so up to
`maxConcurrency` seeds can be in flight when the running sum is just under the cap.
Worst-case aggregate egress is therefore **`maxGlobalEgressBytes + maxConcurrency ×
perSeedMaxBytes`** (= 100 MB + 4 × 5 MB = ~120 MB at the defaults) before the
post-seed re-check short-circuits the remaining seeds. This is a bounded overshoot
of a hard cap, documented honestly like the transform-cost concurrent-overshoot;
the budget tracker tightens it by reserving `perSeedMaxBytes` against the global
budget at dispatch (analogous to the cost-cap reservation).

### Input shaping (before any egress)

The input `urls` array is hard-capped at **200 entries** (valid or malformed,
`too_many_urls`) so thousands of bad/board URLs can't bypass the per-call delivery
ceilings via `failures[]`/`structuredContent`. Then:

`validate → reject Tier-2 board URLs per-entry → reject Ashby-embed seeds per-entry
→ dedupe → per-host cap (truncate + disclose) → total clamp (maxUrls, clamp +
disclose)`. There is NO same-domain scope check in v1 (cross-domain is the normal
case); the per-host cap replaces it as the directed-DoS bound. Tier-2 board-root
seeds are rejected per-entry (`tier2_board_not_supported_in_bulk`): the roster-intact
invariant (a Tier-2 roster must NOT be byte-sliced) is preserved, and the career-site
wedge is single-fetch the board (roster) → bulk the per-JD URLs. **Ashby-embed
(`?ashby_jid=`) seeds are also rejected per-entry** (`ashby_embed_not_supported_in_bulk`):
the embed resolver performs an auxiliary host-page fetch NOT captured by v1's
`result.bytes` egress accounting (BULK-5), so bulk closes it structurally (like
render) — single-fetch embeds, or bulk the direct `jobs.ashbyhq.com/<org>/<id>` URLs.

Per-entry rejects (invalid URL / board root / ashby embed) count toward `failed` and
the overall `status`, so a call with one success + N rejects reports `partial`, not
`pass`.

### Admission-path (load-bearing wiring)

The `captatum_bulk` handler acquires **exactly ONE admission slot for the whole
call** (the same process-wide `AdmissionLimiter`, `MAX_CONCURRENT_MCP=8`, that
wraps single-fetch). The orchestrator receives the **UNWRAPPED**
`CaptatumExecutorPort` — inner per-seed fan-out takes NO admission slots, bounded
instead by the BulkGuard (`maxConcurrency` + union-keyed per-host gate).
`OverloadedError` therefore fires ONLY at the bulk-call boundary (retryable
`-32050`, whole-call) and is NEVER swallowed as a per-seed `tier:"error"`. This
is the only consistent accounting: never wrap bulk's inner per-seed `execute()`
with admission.

### Hosted amplification controls (PR 3 — the flip gate)

Two process-wide controls bound amplification ACROSS concurrent bulk calls
(BULK-1 + BULK-2). Both ship in PR 3; flipping `CAPTATUM_BULK_ENABLED` to ON on
hosted depends on both.

- **`LimitingFetcher` (BULK-2) — global fetch-concurrency cap.** On hosted, the
  `FetcherPort` constructed in `src/server.ts` is wrapped in a
  `LimitingFetcher`: a process-wide FIFO semaphore bounding the number of concurrent
  `fetchGuarded` calls across ALL callers (every single-fetch + every bulk seed +
  every Tier-3 render subresource routes through it). Capacity
  (`CAPTATUM_GLOBAL_FETCH_CONCURRENCY`, default 24) bounds the unbounded worst case
  (admission 8 calls × `maxConcurrency` 4 = up to 32 concurrent fetches) below the
  2 vCPU / 4 GiB sizing, while leaving headroom. Single-fetch shares the same FIFO
  pool as bulk seeds (no priority): under heavy concurrent bulk load a single-fetch
  MAY briefly queue, FIFO-fair, and if its own `timeoutMs` elapses it rejects as a
  retriable `timeout` (no caller hangs on the global gate). The local binary uses
  the RAW fetcher (single-user; a user saturating their own machine is their own
  concern, and per-call caps bound each call).
- **`BulkQuotaPort` (BULK-1) — per-tenant rolling seed-window quota.** Each hosted
  bulk call reserves its seed count against the calling tenant's rolling window
  (`CAPTATUM_BULK_QUOTA_WINDOW_SECONDS` default 60s /
  `CAPTATUM_BULK_QUOTA_SEED_LIMIT` default 300, both operator-tunable) BEFORE any
  dispatch. A reservation that would exceed the window → whole-call fail
  `bulk_quota_exceeded` (retryable, with `retryAfterMs` hint). The port is
  **fail-closed**: a store error (or a missing tenant id when a quota port is
  configured) refuses the bulk (`bulk_quota_store_error`) rather than running
  unbounded. The local binary uses a NOOP quota port (single-user, unbounded by
  design). The default in-memory rolling-window impl is per-process; a distributed
  store is the multi-instance scale path (documented). Tenant id =
  `CaptatumContext.clientId` (the OAuth client; single-fetch reuses `fetch:read`).

### BulkResult envelope (new, `src/domain/bulk-result.ts`)

```
BulkResult {
  schemaVersion: 1, kind: "bulk", bulkId,
  ok, status: "pass" | "partial" | "fail",   // fail = ALL seeds failed
  count, passed, failed, truncated, deduped,
  totals: { bytes, egressBytes, durationMs, transformInTokens, transformOutTokens, transformCostUsd },
  guard: BulkGuard,                          // the caps actually applied (honest receipt)
  capBreaches: [reason],                     // which caps short-circuited the run
  clamp: {                                   // disclosure of input shaping (decision 10)
    inputUrls, afterDedupe, afterPerHostCap, processed,     // counts at each stage
    perHostTruncated: [{ host, kept, dropped }],            // per-host cap disclosure
    totalClampedTo?: number,                                 // set when maxUrls clamped
  },
  fenceToken: string,                        // random per-call separator in content[0].text
  results: [{                                // one per processed seed, INPUT ORDER preserved
    url, finalUrl, status, tier, code, codeText,
    bytes, egressBytes, output, platform, jsRequired, resolvedVia,
    redirectHosts: string[], contentSha256,  // anti-tamper / re-fetch handle
    result,                                  // hard snippet <=500 chars (or board-rejected msg)
    transform?: { provider, model?, reason? },
    warnings: [...], errors: [...],
  }],
  failures: [{ url, code, message }],        // convenience: failed seeds only
  warnings: [...], errors: [...],
}
```

**`renderDiagnostics?`** (#154, additive) — present on the single-fetch + bulk result ONLY on a Tier-3 render-failure outcome (`render_empty`, `render_error`/render-failure); absent on `render_unavailable` (no renderer ran), `render-blocked`, and Tier-1/2 success. Shape: `{ renderedBytes?, domTextLength?, egressBytes?, renderEgressHosts, blockedRequests, forwardedRequests, possibleReason }`. `egressBytes` here is the **Tier-3-only** subresource egress (distinct from `Result.egressBytes`, which includes the Tier-1 doc); `domTextLength` is the browser's live DOM text (captures shadow-DOM/computed text the extractor misses); `renderEgressHosts` are registrable domains (raw IP/single-label hosts redacted to `[ip-literal]` — never a raw IP). `possibleReason` (`render-error | network-blocked | extraction-gap | empty-dom | unknown`) is a **conservative hint, never a trusted diagnosis** — an unclear cause is `unknown`; `bot-wall` is deliberately not a reason (unreliably distinguishable; the #151 `gateReason` antibot signal rides separately when attributable). **Surfacing change:** single-fetch now also surfaces `egressBytes` (parity with bulk) and `renderEgressHosts` (NEW in both — previously internal-only; callers gain the set of registrable domains the page loaded subresources from, a new bounded host-identifier surface). `mainFrameUrl` is not duplicated (use `finalUrl`; `renderEgressHosts` covers a redirect-to-challenge). `renderDiagnostics` reflects the final render attempt only on the bulk-retry path.

### MCP delivery

- `content[0].text`: one bounded blob. Provenance header
  `<!-- captatum kind=bulk count=N … fence=<token> -->` + per-URL sections framed
  by the random fence token (`=== [n/N] <url> (fence=<token>) ===` …
  `=== end (fence=<token>) ===`). Total capped `CAPTATUM_BULK_MAX_TEXT_CHARS`
  (default 50 KB); per-URL capped (default 8 KB); overflow → <=500-char snippet +
  `finalUrl`.
- `structuredContent`: lean `BulkResult` rows, per-entry `result` <=500 chars,
  per-entry `contentSha256` present; total capped ~25 KB, overflow drops the
  snippet (keeps `url`+`status`+`tier`+`code`+`finalUrl`).
- **Prompt-injection (Nx dose):** N entries in one tool result is an inherent Nx
  injection-dose amplification. The fence token is server-generated (never
  echoable from page content); per-entry `contentSha256` is an anti-tamper handle;
  the server instructions state bulk entries are UNTRUSTED data and the consuming
  agent must not act on instruction-shaped text across entries. Per-seed transform
  isolation (one LLM call per seed) is a contract invariant — NO cross-seed
  content concatenation into one LLM input.

### Bulk error codes (per-seed `fail` unless noted)

Per-seed `fail`: `bulk_per_host_cap` (directed-DoS count bound, union-keyed —
incl. render subresource hosts once `allowRender:true`),
`tier2_board_not_supported_in_bulk` (board-root seed rejected per-entry),
`ashby_embed_not_supported_in_bulk` (ashby-embed seed rejected per-entry),
`bulk_deadline_exceeded` (wall deadline — remaining seeds marked failed),
`bulk_budget_exceeded` (egress-bytes or transform-cost cap bit — reason names
which). Per-seed WARNING (the seed still runs, degraded):
`bulk_render_cap_exceeded` (the seed is downgraded to `allowRender:false` because
EITHER the `maxRenderedSeeds` count cap OR the per-call render byte budget was
reached — the warning message names which; a JS shell comes back render-blocked, a
content page is unaffected), `bulk_retried_429` (the seed retried once after a 429/503).
Tool-level error (whole call): input-validation (`invalid_input` /
`too_many_urls`), auth (insufficient scope, `-32003`), admission
`OverloadedError` (`-32050`), `bulk_quota_exceeded` (per-tenant seed-window
exhausted — retryable, carries a `retryAfterMs` hint), and
`bulk_quota_store_error` (quota store unavailable — fail-closed refusal).
Partial failure is NORMAL — a per-seed SSRF block / 404 / timeout / captcha is
one `fail` entry + a `failures[]` row, NOT a tool-level error.

### Recorded additive contract changes (not breaking)

1. `CaptatumContext` gains optional `signal?: AbortSignal` (moved out of
   `captatum.ts` to `src/application/ports/captatum-context.ts`). **Consumed by the
   bulk runtime** — and, since 2026-09, composed with an internal render-lifetime
   controller on EVERY render (in-flight subresource fetches cancel when the render's
   outcome is settled, so single-fetch egress no longer outlives the returned result;
   caller-visible `context.signal` semantics unchanged, teardown aborts contribute no
   provenance actions) — `execute` threads `context.signal` into the Tier-1 `fetchGuarded`
   + the Ashby-embed resolver (the two live fetch paths a bulk seed takes), and the
   guarded fetcher composes it with its own per-tier timeout via `AbortSignal.any`
   so the bulk wall deadline aborts in-flight fetches (surfaced as a per-seed
   `code:"timeout"`). Render abort is FULLY signal-threaded in v1 (the signal flows into
   RenderInput → PlaywrightRenderer closes the page on abort + every subresource fetchGuarded is
   composed with it); transform abort is dispatch-level (raceWallAbort abandons slow LLM calls).
   The Tier-2 board short-circuit is not signal-
   threaded (it does no fetch for a non-board URL, and bulk pre-rejects board roots).
   Additive at the API level: single-fetch callers still pass nothing — but they are
   NOT unchanged at runtime: every render now composes an INTERNAL render-lifetime
   abort (see the parenthetical above), so a no-signal single-fetch render's
   in-flight subresources cancel when its result settles.
2. `ToolAuditEvent.tool` widens to `"captatum" | "captatum_bulk"` and gains
   optional `bulkId?: string`. Bulk emits **per-seed** events (one per seed,
   `tool:"captatum_bulk"` + `bulkId` + `url_host`) plus one **summary** event
   (no per-url body; body allow-list unchanged) carrying `totals` +
   `capBreaches`. Flagged for CloudWatch consumers.
3. `Result.egressBytes?: number` (real network egress — the fetched document
   bytes for Tier-1/Tier-2; `essentialBytes + bytesFulfilled` for a Tier-3
   render, i.e. honest subresource accounting). The budget tracker sums
   `result.egressBytes ?? result.bytes`. `Result.renderEgressHosts?: string[]`
   (the registrable domains a Tier-3 render loaded subresources from — fed into
   the per-host union count gate, BULK-3). `Result.retryAfterMs?: number` (the
   curated `Retry-After` on a 429/503, carried from `FetcherResult`). All
   additive optional fields; absent on legacy single-fetch Tier-1 results.
4. `FetcherResult.retryAfterMs?: number` — curated from the `Retry-After` header
   on a 429/503 (seconds or HTTP-date). Surfaced on the `FetcherResult` and
   threaded to `Result.retryAfterMs`; the bulk orchestrator performs ONE
   jittered retry per 429/503 seed (bounded by the wall), disclosed as a
   `bulk_retried_429` warning. Single-fetch surfaces `retryAfterMs` on the
   receipt but does NOT auto-retry (unchanged behavior).
5. `CaptatumContext` gains optional `clientId?: string` (the OAuth client id),
   threaded by the MCP handler so the bulk orchestrator can key the
   `BulkQuotaPort` reservation per tenant. Additive: single-fetch + local pass
   nothing and are unchanged.
6. `ToolAuditEvent` (already widened in PR 1/2 to `tool:"captatum"|"captatum_bulk"`
   + `bulkId?`) gains optional `quotaReserved?: number` /
   `quotaWindowSeconds?` on the bulk summary event when a `BulkQuotaPort` is
   configured, so per-tenant spend is auditable.

### Two flavors (one core)

- **Local binary:** ships ON (single-user, no auth, no admission cap,
  `BulkQuotaPort` = noop, raw `FetcherPort` — no global fetch cap). The
  BulkGuard caps bound each call.
- **Hosted remote:** ships ON as of PR 3 (`CAPTATUM_BULK_ENABLED` default
  **true**), gated behind the `LimitingFetcher` (global fetch-concurrency cap,
  BULK-2) + `BulkQuotaPort` (per-tenant seed-window quota, BULK-1) which both
  landed in PR 3. The 8-slot admission wraps the bulk call (1 slot/call); the
  `LimitingFetcher` wraps the `FetcherPort` (global fetch cap across all
  callers); the `BulkQuotaPort` bounds per-tenant amplification across calls.
  Reuses `fetch:read` / `fetch:transform` (no separate `bulk:read` scope in v1).
  Operators may set `CAPTATUM_BULK_ENABLED=false` to disable hosted bulk
  independently of the local flavor.

## Provenance / Result schema

Extends WebFetch's output shape (`bytes`, `code`, `codeText`, `result`, `durationMs`, `url`) so it's familiar to agents/clients, then adds provenance:

```
Result {
  // WebFetch-compatible core
  url,                        // requested URL
  bytes,                      // fetched content size (bytes)
  code, codeText,             // HTTP status of the final response
  durationMs,                 // total wall-clock
  result,                     // payload the agent consumes: raw content (default, no provider) | summary text (default with provider) | extracted JSON
  // captatum provenance
  schemaVersion: 1,
  finalUrl, redirects: [{ url, status }],
  tier: 1 | 2 | 3 | "none" | "error" | "render-unavailable" | "render-blocked",
  output: "summary" | "raw" | "extract",          // ACTUAL output (after any degrade)
  outputRequested: "summary" | "raw" | "extract", // what the caller asked for; differs from `output` when a summary/extract degraded to raw (#153). Absent on legacy results.
  platform: { adapterId, label, detectedFrom },   // adapterId: "generic" (Tier-1) or a platform id e.g. "greenhouse"/"lever"/"ashby" (Tier-2)
  jsRequired: boolean,
  resolvedVia: string,                            // e.g. "tier1-jsonld", "tier1-json", "tier1-text", "tier3-playwright"
  attempts: [{ step, tier, outcome, status?, durationMs, bytes?, reason? }],
  contentType,
  title,                                          // when derivable
  structured: { canonicalUrl?, jsonLd?, og?, meta?, appState?, images? }, // parsed from raw HTML (present when found); images = bounded absolute http(s) image URLs (og:image*, JSON-LD image/ImageObject, <img>/<source srcset>); private/localhost hosts stripped, never fetched by this service
  transform: { provider, model?, free?, inTokens?, outTokens?, latencyMs?, costUsd?, reason?, schemaIssue?, fallbackFrom?, truncated? }, // present on summary/extract or fallback; reason = typed TransformReason enum (#153); schemaIssue = non-fatal extract-schema advisory; truncated = the summary was cut at the model's output ceiling after escalation (#125)
  timings: { totalMs, fetchMs, renderMs?, transformMs? },
  errors: [{ code, message }],
}
```

Timestamps are caller-injected (`fetchedAt?: string`). No `Date.now()` in core (CI grep enforces).

When guarded fetch rejects before any HTTP response is safely available, the
core still returns a contract-shaped `Result`: `code: 0`,
`codeText: "FETCH_REJECTED"`, `tier: "error"`, `resolvedVia:
"guarded-fetch"`, `errors[0]` preserves the original guarded-fetch
`{ code, message }`, and extraction/render/transform are not called.

## MCP structuredContent (agent-facing, lean)

The `Result` above is the **internal** record (full provenance, used by tests,
the audit log, and `debug` mode). What the tool returns as MCP
`structuredContent` is a **lean agent payload** built from that Result: it keeps
the load-bearing primitives agents/connectors already read at the same paths
(`result`, `tier`, `title`, `output`, `code`, `bytes`, `platform`, `errors`,
lean `transform`) and adds a tiered envelope, while gating the heavy diagnostic
fields behind `debug: true`. The MCP `text` content (provenance line + result)
is unchanged either way — that is the primary agent channel.

Default (lean) `structuredContent`:

```
{
  schemaVersion: 1,
  ok: boolean,                         // status !== "fail"
  status: "pass" | "partial" | "fail",
  url, finalUrl, title, output, outputRequested,   // outputRequested (#153): what the caller asked for; != output when degraded
  contentType: "article" | "job" | "json" | "pin" | "product" | "spa" | "unknown",   // classified from the raw HTTP content-type (json), JSON-LD @type / og:type / host / jsRequired
  result,                              // summary text | raw content | extracted JSON (string)
  tier, code, codeText, bytes,         // kept for existing consumers
  resolvedVia, platform, jsRequired,
  access: { mainContentAccessible, gated, gateReason: "paywall"|"js-required"|"captcha"|"bot_verification"|"byte_cap"|"http_error"|"none" },
  contentQuality?: "app_error" | "low_value",   // present only when a successful fetch's bytes aren't real/usable content (#145/#150)
  provenance: { tier, resolvedVia, code, bytes },     // convenience envelope
  warnings: [{ code, message }],       // non-fatal: advisories, render-failed-but-tier1-ok, byte-cap/body_read_error truncation, schema_knob_extracted, extract_schema_invalid, transform_truncated, low_value_extraction
  images: ["https://…"],               // bounded absolute http(s) URLs for optional multimodal vision fetch
  errors: [{ code, message }],         // fatal only (tier === "error")
  transform: { provider, model?, free?, inTokens?, outTokens? },   // lean token-efficiency signal; present when a transform ran
}
```

Rules:
- **title:** every MCP presentation channel canonicalizes the untrusted page
  title through one Unicode-category allowlist before emission. Only letters
  (`L`), marks (`M`), numbers (`N`), punctuation (`P`), symbols (`S`), and
  space separators (`Zs`) survive. Controls and format characters (`Cc`/`Cf`,
  including C1 controls, bidi isolates/overrides, and zero-width formats), line
  and paragraph separators (`Zl`/`Zp`), surrogates, private-use, and unassigned
  code points are removed. The result is clipped to 140 Unicode code points
  without splitting a surrogate pair and omitted when empty. The internal
  `Result.title` remains unchanged.
- **errors vs warnings:** fatal ⟺ `tier === "error"`, except `schema_knob_extracted`, which is always a non-fatal warning even when a later fetch rejects. Everything else in `Result.errors` becomes a `warning` outside `tier: "error"`.
- **status:** `fail` when `tier === "error"`, the response was 4xx/5xx (the body is an error page, not usable content), or no body content was returned; `partial` when content was returned but warnings exist or the summary/extract transform fell back to raw (`transform.provider === "none"`); else `pass`. A successful candidate-MODEL fallback is a `pass` (not `partial`) — the failed-primary list rides on `transform.fallbackFrom` (debug + audit only), not a warning (#82).
- **access.gateReason:** `captcha` when the fetched bytes are a **vendor-attributed** bot-protection challenge (a Cloudflare/Akamai/PerimeterX/DataDome/Imperva challenge-only body marker or the `cf-mitigated` header), with the vendor in `access.challengeProvider` (#41); `bot_verification` when a 429/503 response body is a **generic** browser-verification interstitial (e.g. "verifying your browser") with no attributable vendor — status-gated (429/503) + non-JSON; the phrase is scanned over the **full response body** (it can sit deep under a large `<head>` — Vercel's checkpoint buries it ~28 KB in), so the scan window is never the reason a wall is missed, `challengeProvider` absent (#151); `paywall` when JSON-LD declares `isAccessibleForFree: false`; `byte_cap` when the response was truncated at the cap; `js-required` when no content was returned on a page that needed JS we could not run (render-blocked/render-unavailable/`jsRequired`); `http_error` when the response was 4xx/5xx (an error page — the body is still returned in `result` for the agent to read the server's message); else `none`. `captcha`/`bot_verification` take precedence over `http_error` so a 429/503 challenge wall is named as such, not as a generic error page.
- **contentType:** `json` when the response's HTTP content-type is `application/json` (or a `+json` suffix); else `pin` for pinterest.*/pin.it hosts; else from the first content-bearing JSON-LD `@type` (`JobPosting`→job, `Product`→product, Article family→article); else `og:type`; else `spa` when `jsRequired`; else `unknown`.
- **images:** never fetched by this service — surfaced for the calling agent's optional vision fetch. Private/loopback hosts are stripped (string check, no DNS).
- **result:** snippeted to ~2000 chars in `structuredContent` when large; the full text is always delivered as MCP `content[0].text` (the primary agent channel), so mirroring a huge body in the structured payload would only duplicate tokens. Summaries are small and pass through unchanged.
- **contentQuality:** present only when a SUCCESSFUL fetch's bytes aren't real/usable content (#145/#150), so an agent never mistakes HTTP success for content success. `"app_error"` = the page is a client-app error-boundary screen (HTTP 200, non-empty crash text like "Something went wrong") that the render promoted — **demoted to `tier:"error"`** (status `fail`) with a `render_app_error` error; the crash text stays in `result` for the agent to read. `"low_value"` = HTTP success but near-empty useful content — a large page (≥100k bytes) whose extracted text is <500 chars and carries no content-bearing JSON-LD (e.g. a SPA whose visible text is just "Careers", a non-English job board whose static HTML is chrome-only, or a map/video/canvas widget whose content is non-textual) — a **non-fatal, tier-aware `low_value_extraction` warning** (status `partial`). It judges **TEXT-extraction** quality specifically: the body is still returned, `images[]` are surfaced for an optional vision fetch, and JSON-LD metadata stays available via `output: raw`; a metadata @type (`VideoObject`/`Organization`) does NOT exempt the page, to avoid diverging from the shared `hasContentBearingJsonLd` predicate. Both detectors are conservative (multiple strong signals: a short result matching a known crash signature; or large bytes ≫ tiny text AND no content-bearing JSON-LD). The English-only title signal that was here was dropped in #179 — post-#152 the JSON-LD predicate is strong on its own, and the title was the sole recall blocker for non-English/branded titles. Absent = normal content.

`debug: true` adds the heavy fields (`attempts`, `timings`, full `structured`
including JSON-LD `description`/`articleBody`, `redirects`, `durationMs`,
`httpContentType`, `contentSha256`, `provenanceHash`, and the verbose `transform`
with `latencyMs`/`costUsd`/`schemaIssue`) and replaces the lean `transform` with
the full one. The lean payload never carries the full `structured` blob, so
JSON-LD `description`/`articleBody` no longer duplicate the `result` text by
default. The lean `transform` keeps `reason` (the small fallback signal that
distinguishes a real summary from a silent raw fallback); only `latencyMs`/
`costUsd`/`schemaIssue` are debug-gated.

**v0 wire-shape evolution (noted breaking changes vs the previous default
`structuredContent`):** under v0 (fields may be added freely; removals/renames
are breaking and noted here) the default payload now (a) drops `timings` and the
`structured` blob (moved behind `debug`), (b) moves non-fatal advisories out of
`errors` into `warnings` (so `errors` now holds fatal entries only — `tier:
"error"`), and (c) trims `transform` to the lean fields above. The MCP `text`
channel and the load-bearing primitives (`result`, `tier`, `title`, `output`,
`code`, `bytes`, `platform`, `errors` for fatal cases) are unchanged. Consumers
that read `structuredContent.timings`, `structuredContent.structured`, or
success-tier `errors` should pass `debug: true` or read `warnings`. The domain
`Result` and its `schemaVersion: 1` are unchanged — only the presentation changed.

`access.gateReason: "captcha"` is emitted by the anti-bot detector (#41) for
vendor-attributed challenge bodies/headers, with the vendor in `access.challengeProvider`;
`"bot_verification"` is emitted for status-gated (429/503) generic browser-verification
interstitials with no attributable vendor (#151). Both take precedence over `"http_error"`
so a 429/503 challenge wall is named as such, not as a generic error page.

### Frozen application-agent compatibility profile

`application-agent` consumes a deliberately frozen subset of the v0.20.0
single-tool wire contract. "Profile" here names the request/response contract,
not a `CAPTATUM_CLIENT_PROFILES` runtime shaping entry. It applies when the
authenticated caller invokes `captatum` with `output:"extract"` and
`debug:false`; other calls retain the ordinary v0 additive-field rule. For this
profile, additive fields, reordered text-header lines, extra
JSON-RPC/result/content members, and new nested receipt members are breaking
changes even while the broader contract remains v0.

The request is stateless `POST /mcp` with protocol `2025-11-25`,
`Accept: application/json, text/event-stream`, and one JSON-RPC `tools/call`.
The tool name is `captatum`; the application-owned call fixes
`output:"extract"`, `allowRender:true`, `debug:false`, `timeoutMs:20000`,
`maxBytes:2097152`, `budget:4000`, its fixed prompt, and its closed job schema.
The response `id` equals the request `id`; no SSE body or `MCP-Session-Id`
participates in authentication.

A successful result has exactly:

```
{
  "jsonrpc": "2.0",
  "id": <request id>,
  "result": {
    "content": [{ "type": "text", "text": "<frame below>" }],
    "structuredContent": { "<receipt below>": "..." }
  }
}
```

`content` has exactly one text item and no extra member. Its `text` is:

```
<!-- captatum tier=<1|2|3> output=extract status=200 bytes=<n> finalUrl=<https-url> platform=<id> jsRequired=<true|false> resolvedVia=<code> -->

contentType: <classified type>
[title: <sanitized title>]
finalUrl: <same https-url>
access: public
[contentQuality: <fixed code>]
images: <count>[ (e.g. <first URL>)]
transformModel: <model>

<one JSON document>
```

The provenance keys and header lines are in exactly the shown order. Generic
provenance additions such as `truncated` or `contentQuality` are suppressed for
this profile; `contentQuality` belongs only in its fixed header position.
`title` and `contentQuality` are the only conditional header lines and keep
their shown positions. The title uses the shared Unicode-category allowlist
above, is clipped to 140 Unicode code points, and the same canonical value is
emitted in `structuredContent`; a title that canonicalizes to empty is omitted
from both channels. There is one blank line after the provenance comment and
one after the header. No extra header line is permitted. The bytes after the
second blank line are the complete extracted JSON document.

The default `structuredContent` object has exactly these required keys, in any
JSON object order: `schemaVersion`, `ok`, `status`, `url`, `finalUrl`, `output`,
`outputRequested`, `contentType`, `result`, `tier`, `code`, `codeText`, `bytes`,
`resolvedVia`, `platform`, `jsRequired`, `access`, `provenance`, `warnings`,
`images`, `errors`, and `transform`. The only permitted conditional top-level
keys are `title`, `contentQuality`, and `egressBytes`. The nested shapes are
closed too:

- `platform` is exactly `adapterId`, `label`, `detectedFrom`;
- public `access` is exactly `mainContentAccessible:true`, `gated:false`,
  `gateReason:"none"`;
- `provenance` is exactly `tier`, `resolvedVia`, `code`, `bytes`;
- `transform` is exactly required `provider`, `model` plus optional `free`,
  `inTokens`, `outTokens`;
- `warnings` and `errors` are empty on accepted success.

A successful extract from a page classified `contentQuality:"low_value"` still
has `status:"pass"`: the fixed `contentQuality` field carries that page-quality
signal, and its otherwise-duplicate `low_value_extraction` advisory is omitted
from `warnings` for this profile. Any independent warning or transform fallback
remains `partial` and is not an accepted application-agent success.

The text frame and structured receipt MUST agree on `output`, `finalUrl`,
`tier`, `code`, `bytes`, `resolvedVia`, `platform.adapterId`,
`jsRequired`, `contentType`, optional title/content-quality, and transform
model. `structuredContent.result` is the canonical lean snippet of the complete
JSON text, so a consumer can cross-check it without treating the snippet as the
full document.

## Ports

- **`FetcherPort`** — the single hardened egress. `fetchGuarded(url, opts, postInit?) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`. Every outbound request (Tier-1, Tier-2 adapter, every redirect hop, every Tier-3 in-browser request) routes through it. The optional `postInit: { method: "POST"; body: Uint8Array; requestContentType?: string }` (#111) carries a first-party POST body on the INITIAL request only — `fetchWithRedirects` reverts to GET + no body on any 3xx (incl. 307/308, a deliberate deviation from RFC 7231) so the body can never reach a redirect target host.
- **`PlatformAdapter`** — `{ id, detect(ctx): DetectResult | null, resolve(input, fetcher): Promise<ResolveResult> }`. Registered in `src/application/adapters.ts`. Optional general-purpose extension point: adding a platform = one folder under `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of the public contract.
- **`StorePort`** — OAuth state only: auth-code records and refresh-token records
  (hashed), plus `close()`. Owned by the **mcp-sso** library
  (`mcp-sso/store/sqlite`); captatum builds it in the composition root and hands
  it to the mcp-sso `Bridge`.
- **`ClientStore`** — stored DCR + machine-client registrations: `save(client)` /
  `find(clientId)`, plus the mcp-sso atomic machine-mutation contract used by the
  operator CLI. Captatum supplies the SQLite adapter and gives the same instance
  to stored DCR, `client_credentials`, and the operator CLI. Machine provision,
  rotation, and disable use insert/CAS mutations that commit the client row and
  required durable audit row in one transaction. The local stdio bridge opens
  neither store.
- **`ModelRouterPort`** — `pick(task, inputTokens, options?): { provider, model?, free?, reason? }` + `feedback({ model, outcome })` driving sticky per-model health (a model demotes one rank only on SUSTAINED hard failure — ≥3 of the last 5 attempts; transient empties and soft/garbage output don't demote). `options.localOnly` is used for sensitive-content signals so hosted providers are bypassed. Implemented by `src/infrastructure/llm/model-router.ts`.

## Tiers

- **Tier-1 (default).** `wreq-js` fetch (browser TLS/JA3+JA4 fingerprint impersonation → anti-bot) + raw-HTML extraction: JSON-LD `<script application/ld+json>`, Open Graph/twitter meta, canonical, and embedded app state (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. Tier-1 egress is still behind `FetcherPort`; direct `wreq-js` calls are not allowed to bypass guarded DNS/IP checks. A **shell-gate** decides whether the page has real content (→ done) or is an empty SPA shell (→ escalate). Structured data satisfies the shell-gate only when the JSON-LD carries a **data `@type`** — a frozen allowlist (`JobPosting`, the Article family, `Product`, `Event`, `Recipe`, `Review`, `Course`, `HowTo`, `FAQPage`, `Question`, `Dataset`, media titles, business types, `SocialMediaPosting` on pin pages, …) — or a named-framework app-state (`__NEXT_DATA__`/`__NUXT_DATA__`/`__INITIAL_STATE__`/`__PRELOADED_STATE__`/`__APOLLO_STATE__`); scaffolding / `@type`-less / metadata JSON-LD (a `WebPage`/`SearchResultsPage` tagline, org/breadcrumb metadata, a `VideoObject`/`AudioObject` embed) does **not** (#152, next step of #109). So a JS-rendered listing page (e.g. a job board) whose static HTML carries only metadata JSON-LD escalates to render instead of stopping at an empty/thin Tier-1 — an **allowlist, not blocklist**, decision at the trust boundary (untrusted JSON-LD). On a page with no `<main>`/`<article>` landmark, the fallback visible-text extraction excludes site chrome (`<aside>`/`<nav>`; `<footer>` is deliberately kept — a static page may carry real content there, so it is not stripped in the no-landmark path) so an SPA shell whose static HTML carries only a nav menu / TOC sidebar (e.g. Jira REST docs) doesn't satisfy the gate and still escalates to render (#144). If the no-landmark body carries a **recognized main-content container** (a curated, high-precision ID/class allowlist — MediaWiki `#content`/`#bodyContent`/`#mw-content-text`, `#main-content`, `#layout-content`, `.entry-content`, `.refentry`, `.td-content`, …), the visible-text scope is narrowed to it so a CMS/reference page (cppreference, php.net) leads with its article, not the top-bar/sidebar bare-`<div>` chrome. A container is accepted only under a two-axis length floor (a fraction of the page's visible text AND an absolute minimum), so a below-floor false-positive container never loses content; with no recognized container the chrome-stripped whole-body fallback stands unchanged. This is an allowlist (precision over coverage); a generic density reorder for pages with no conventional container is a documented extension point, not in this change (#165). `stripHtmlTags` is quote-aware: a `>` inside a quoted attribute value is not a tag terminator, so inline directive JS (Alpine/Vue/Tailwind `x-init`/`@click`) is not leaked as visible text (#146); the landmark-path pre-clean strips `<aside>`/`<nav>`/`<footer>` (unchanged). Generic main-content extraction uses a hand-rolled visible-text extractor that drops DOM a browser would not render (`display:none`, the `hidden` attribute) — but not `visibility:hidden`, which a descendant can override with `visibility:visible` (so dropping its whole subtree would lose genuinely visible content). This keeps config blobs hidden in the markup (e.g. a vscdn career page's `themeOptions`/branding JSON inside `<code style="display:none">`) from being counted as visible content (regression: that ~22KB config dominated `output:raw` and satisfied the shell-gate so Tier-3 never ran). All raw-HTML scanners (element/close-tag, comment, `<style>` display:none class, svg `<text>`) are single-pass linear with a monotonic close-tag search cursor, so an unclosed-same-tag flood within the 5 MB extraction cap cannot stall the synchronous event loop (REDOS-5). The hidden-subtree stripper is a single linear pass with a per-subtree step guard; `output:raw` leads with the content-bearing JSON-LD text **harvested per type** — a `JobPosting`/`Article` `description`/`articleBody`, a `Review.reviewBody`, `Recipe.recipeInstructions`, `HowTo` steps, `FAQPage` Q&A pairs, a `Dataset`/media-title/business `description` (the frozen `CONTENT_FIELDS` map, length- + count-capped) — when present, visible body text only supplementing it (#152). `defuddle` was **evaluated and not added** — empirical probes against rendered SPAs (Vue/Angular RealWorld, TodoMVC) showed the existing extractor already yields clean main content, and a DOM-parser dependency would expand the untrusted-HTML parse surface without justification (house rule: minimal deps). The `<title>` is derived from JSON-LD when a content-bearing node (JobPosting/Article/…) carries a more specific title than the page `<title>` — fixes embedded-widget/iframe pages whose `<title>` is the host page. When multiple content-bearing JSON-LD nodes are present, the **first in document order wins** (treated as the page's primary content); this is a deliberate heuristic, not a type ranking.
  Limitation (security-required, not a deferral): `wreq-js` is used only for
  plain HTTP; HTTPS delegates to the Node requester, so `wreq-js` TLS/JA3+JA4
  fingerprinting is not active for HTTPS. `wreq-js` exposes no connect-to-
  resolved-IP or custom-DNS option — its `RequestInit` offers only `proxy`/
  `browser`/`os`/`insecure`/`transport`, and DNS is resolved internally in the
  native layer. Using it for HTTPS would force an unsafe choice: let wreq
  self-resolve (a **rebinding SSRF hole** — the guard checks IP A, wreq may
  connect to IP B) or set `insecure: true` (a **MITM hole** — disables cert
  verification). The rebinding-proof SSRF guarantee is non-negotiable, so HTTPS
  keeps the checked-IP Node path. Revisit only if `wreq-js` adds a connect-to-IP
  or custom-resolver API.
- **Tier-2 (optional).** If a registered `PlatformAdapter` detects the URL, it resolves via that platform's public API (clean JSON), short-circuiting extraction/render. Adapters are optional and general. **Shipped: ATS "list all jobs" adapters** (Greenhouse, Lever, Ashby). A career-board URL on an ATS host — a board ROOT such as `boards.greenhouse.io/{token}`, `jobs.lever.co/{site}`, `jobs.ashbyhq.com/{org}`, or the matching list-API hosts (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`) — is detected from the URL host. A single-job detail URL (`/{token}/jobs/{id}`, `/{site}/{postingId}`, `/{org}/{jobId}`) or a Greenhouse `?gh_jid=` single-job link is intentionally NOT claimed — it falls through to Tier-1 so the specific job's JSON-LD is extracted rather than the whole roster; the board token is extracted from the path and sanitized against a fail-closed slug charset (`[A-Za-z0-9._-]`, ≤128 chars) so a crafted URL cannot steer the request elsewhere; the API URL is rebuilt with `new URL` (host pinned) and fetched **through `FetcherPort`** (rebinding-proof SSRF, byte-capped). Verified list endpoints (no auth, routinely scraped): `boards-api.greenhouse.io/v1/boards/{token}/jobs` (metadata only — descriptions omitted so a 168-role board is ~100KB, not 1.8MB), `api.lever.co/v0/postings/{site}?mode=json` (`mode=markdown` is 406), `api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true`. The response is safe-parsed (prototype-pollution-safe reviver); the INPUT array is capped (cap-then-map) so a large/malicious board cannot pin the event loop normalizing 100k+ jobs, and the output is normalized to a bounded, cross-ATS roster envelope `{platform, board, jobCount, truncated, jobs:[{id,title,url,location,department,team,employmentType,workplaceType,remote,publishedAt,compensation}]}` — full description HTML is dropped (deep-fetch a single JD's `url` at Tier-1, which serves a clean JobPosting JSON-LD), the roster is capped at 500 with a `truncated` flag, and `jobCount` reports the true board size. Field availability is per-ATS: Greenhouse's metadata-only response omits per-job `departments`, so `department` is `null` for Greenhouse (populated for Lever/Ashby); `compensation` is populated for Ashby (`includeCompensation`) and Lever (`salaryRange`/`salaryDescriptionPlain` when present), `null` for Greenhouse; Ashby postings marked `isListed:false` (direct-link-only) are excluded from the roster and the count. Lever API-host list queries preserve the caller's filters (`department`, `team`, `skip`/`limit`, …) while forcing `mode=json`. On no detection, an unknown board (404), a byte-truncated response, or any fetch/parse failure, Tier-2 yields nothing and the request falls through to the generic Tier-1 path — Tier-2 is strictly best-effort and never blocks the generic path. A Tier-2 result carries `tier: 2`, `platform.adapterId` of the ATS (`greenhouse`/`lever`/`ashby`), `resolvedVia: "tier2-<ats>"`, `contentType: "application/json"`, and `bytes` reporting the bytes **fetched from the API** (egress/audit, matching Tier-1 semantics — not the smaller normalized roster size); `output: "raw"` returns the JSON roster, `output: "summary"` summarizes it (a failed/absent summary returns the full roster intact rather than byte-slicing the JSON). Custom-domain career pages that *embed* an ATS board script are recognizable via the adapter's `detect({html})` (the embed-script markers are implemented + unit-tested; wiring that discovery into a post-fetch pass is the follow-up). The single-job Ashby-embed resolver (`?ashby_jid=` on a custom domain → direct Ashby job URL → Tier-1 JSON-LD) is a separate, unaffected path.
- **Tier-3 (core, gated by `allowRender`).** Lazy `import('playwright')`;
  render with hard timeouts + request interception. Every non-aborted GET
  (document/script/fetch/XHR/stylesheet/…) — and a first-party **POST** (fetch/XHR
  only, same registrable domain — #111) — is **fulfilled** through `FetcherPort`
  via `route.fulfill` — the browser never resolves or connects on its own, so the
  DNS-rebinding and redirect TOCTOU that a `route.continue()` guard leaves open
  are impossible, and every redirect hop is re-validated (`maxHops` enforced) by
  the fetcher. Image/font/media/analytics URLs are checked with the same P1
  URL/DNS private-IP guard and then aborted;
  websockets are closed; Service Workers are disabled; downloads are blocked;
  cumulative browser fetch bytes are capped. Final rendered HTML bytes that
  exceed the cap are **truncated** (UTF-8-safe) and surfaced as a non-fatal
  `max_bytes` provenance note rather than rejecting the render — the bytes are
  already in memory, so a truncated render beats throwing it away. The Tier-1
  fetch-path byte cap remains a **hard reject** (a pre-download bandwidth/abuse
  guard). The
  rendered `page.content()` is reused by the Tier-1 extractor and provenance
  records tier 3 plus browser control actions (`service-workers-disabled`,
  `request-blocked`, `resource-aborted`, `websocket-closed`,
  `download-blocked`, `popup-closed`). Interception is installed at the
  **context** level (`context.route`), which covers every page in the render
  context including `window.open` / `target=_blank` popups — popups are
  additionally **closed on sight** (`popup-closed` action), because a
  fetch-render has no use for a popup target and page-level routing alone
  leaves popups egressing browser-direct. Both acquisition modes also launch
  Chromium with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`:
  WebRTC ICE/STUN is transport-layer UDP below request interception. Measured
  (2026-09-01): the flag BLOCKS STUN-to-server UDP in the headless-shell binary
  (the local flavor's launcher) and is inert for it in full Chromium
  `--headless=new` (the hosted sidecar) — on hosted, the Pod-netns firewall is
  the load-bearing control — and it is a DEPLOYMENT PREREQUISITE this repo does not
  ship: the reference browser-Pod topology (init-container default-drop OUTPUT rules,
  CDP relay, ingress NetworkPolicy) lives outside this repository, so a self-hoster
  building the published images MUST provide an equivalent browser-egress boundary of
  their own; without one, hosted Tier-3 is UNSUPPORTED — leave
  CAPTATUM_BROWSER_CDP_ENDPOINT unset (Tier-3 reports render-unavailable) rather than
  run the browser beside the gateway;"
   on local (the headless-shell launcher), the flag is the load-bearing control. The browser receives no gateway secret in its environment. **Two acquisition modes** (factory `createRenderer()`, config-driven): (a) **CDP browser workload** — connect to long-lived Chromium via `CAPTATUM_BROWSER_CDP_ENDPOINT` (the hosted path; connection cached + reused, never closed per-render; `--no-sandbox` is acceptable there because the container is the isolation boundary); (b) **in-process launch** — `chromiumSandbox` defaults **true** (the local-binary path; `--no-sandbox` in-process is only a transitional opt-in via `CAPTATUM_BROWSER_INPROCESS_SANDBOX=false`). The endpoint is parsed before any hosted state-directory or database side effect. Its positive allowlist shape is exactly `http://<service>.<namespace>.svc.cluster.local:9222`, where service and namespace are DNS-1123 labels; credentials, query, fragment, non-root path, loopback, IP literals, arbitrary external hosts, HTTPS, and other ports fail boot. This keeps the deployment-owned service name out of Captatum while preventing a loopback endpoint from placing the no-sandbox browser back in the gateway network namespace. Chromium itself remains loopback-only on TCP/9222 inside its separate Pod. The production browser image also ships a fixed TCP relay entrypoint: it listens on `0.0.0.0:9223`, forwards only to `127.0.0.1:9222`, caps simultaneous connections at 32, and accepts no configurable target. The browser Service maps TCP/9222 to that relay inside the isolated browser Pod. The browser launcher accepts only loopback bind address `127.0.0.1` and a decimal port in `1..65535`. Either way the browser never runs in-process with `--no-sandbox` against the gateway's blast radius. The context-level route SSRF guard applies identically in both modes. If Playwright is
  absent → `render-unavailable`. **When it applies:** Tier-3 fires when Tier-1
  finds an empty SPA shell or no usable structured data — e.g. client-rendered
  React/Vue/Svelte apps whose HTML is a `<div id="root">` stub; pages that load
  content via XHR/fetch after `load`; JS-only docs/demos (Docusaurus/Storybook
  in SPA mode); content behind a Cloudflare/anti-bot interstitial that needs a
  real browser; and embedded widgets rendered client-side on a third-party
  domain (e.g. an Ashby board). On hosted these render automatically (`allowRender` defaults true);
  set `allowRender: false` to keep a bare `captatum` from spawning a browser.

## Transform (default output path)

The Transform stage handles `output: summary`/`extract`: resolved content is turned into a token-efficient answer to `prompt` — the role WebFetch's Haiku step plays, but fed by accurate rendered/extracted content and routed through the free-model router so it's cheap. It runs by default only when a provider is configured; otherwise the default is `raw` (no Transform pass).

Modes: `summarize` (default — concise answer to `prompt`, optionally to a token `budget`) and `extract` (structured JSON per `schema`). `output: raw` skips the LLM and returns clean resolved content.

`extract` validates the provider's JSON before returning it. The validator enforces the supported JSON Schema subset used by this tool (`type`, `required`, `properties`, `additionalProperties`, `items`, `enum`/`const`, string length/pattern, numeric bounds, array/property counts, uniqueness, and `allOf`/`anyOf`/`oneOf`/`not`). Before the supported-keyword allowlist runs, a non-conforming client that merged one of exactly six root-level Captatum arguments — `budget`, `timeoutMs`, `allowRender`, `debug`, `maxBytes`, or `transform` — into `schema` is repaired: Captatum shallow-clones the object, revalidates the value through the same input field parser without coercion, then removes the nested key. It applies that value only when the real top-level argument is absent; otherwise the top-level value (including `allowRender: false`) wins and the nested value is discarded. Each outcome emits a distinct non-fatal `schema_knob_extracted` warning that never echoes a schema value. Nested property names are never changed. The cleaned schema is then checked at the input boundary. **Every other unsupported keyword is rejected** (`extract_schema_unsupported_keyword`, JSON-RPC `InvalidParams` / HTTP `{error:{code,message}}`, before any fetch/LLM) — the validator is an allowlist, so `format`, `contentEncoding`, an invalid recoverable value, bulk-only cost knobs, or a misplaced URL/output/prompt field still fail closed rather than accepting unvalidated structured data. The same recovery and allowlist check runs once for `captatum_bulk`'s uniform schema; its warning is call-level, not repeated for every seed. A defense-in-depth copy of the check remains at the transform seam (`finalize`) for any path that bypasses input normalization; on the rare reach it degrades with `transform.reason: "schema_validation_failed"`. For **supported** keywords, a value mismatch (wrong type, `minLength`, etc.) is **advisory**: the parsed JSON is still returned (imperfect structured data > raw fallback) but the mismatch is surfaced as a non-fatal `extract_schema_invalid` error so the caller is not silently handed schema-violating data.

Provider-configurable via `transform`: **OpenRouter** (default; OpenAI-compatible `chat/completions` over plain `node:https`, key from config) or **local Ollama** (zero egress only when `OLLAMA_BASE_URL` is loopback; a remote HTTPS Ollama is classified as a hosted provider and bypassed for sensitive content). Every provider call carries a bounded `max_tokens`/`num_predict` — the server default when `budget` is omitted, **clamped to the chosen model's max output (#125: deepseek-v4-flash 16 384, qwen3.6-flash 65 536, default 8 000 — replacing the old global 4 000 ceiling that silently truncated heavy doc pages)** — so a missing `budget` cannot trigger unbounded paid generation. If a completion still returns `finish_reason=length`, the router **escalates the budget** (doubling up to the model's max, then falling to a higher-cap candidate) and only if it still truncates surfaces a non-fatal `transform_truncated` advisory — the caller is never silently handed a cut-off answer. As a prompt-side complement, the `summary` instruction also directs the model to answer the most decision-relevant parts of the request first and omit a lower-priority section whole rather than cut off mid-answer when space may be limited, so a summary that still hits the cap leads with the important fields; this never licenses dropping items the caller asked to list, extract, or enumerate (the verbatim-item rule is unchanged), and `extract` is unaffected. (#155) The model router enforces a policy hosted routers won't: free-first (`pricing.prompt=="0"`), per-request fit (context length, text modality — filter out audio/coding/image models, JSON-schema support for `extract`), with deterministic **sticky per-model health** (a hard failure — throw / empty / non-2xx / invalid JSON / unsupported schema keyword — pushes into a 5-attempt window; ≥3 hard failures demote one rank, recovering after 2 consecutive successes; soft/garbage output does NOT demote) and a fallback chain: best free → cheap paid (Flash/Haiku) → local Ollama. Provenance records `{provider, model, free, inTokens, outTokens, latencyMs}`. On failure, fall back to raw content + a provenance flag.

Privacy: fetched content is mostly public web content; the only egress risk is non-public content (authed/signed URLs, internal hosts) → detect via signals and route to Ollama or skip.

**Setup & fallback.** Configure `OPENROUTER_API_KEY` (OpenRouter) and/or `OLLAMA_BASE_URL` (local Ollama) in the environment; `OPENROUTER_MODELS` overrides the comma-separated OpenRouter fallback list, `OPENROUTER_BASE_URL` overrides the API base (must be `https://` for any non-loopback host — a non-loopback `http://` base is rejected at boot to prevent cleartext API-key egress), `OLLAMA_MODEL` selects the local model, `TRANSFORM_TIMEOUT_MS` sets provider-call timeouts, and `TRANSFORM_MAX_OUTPUT_TOKENS` sets the default output-token budget applied when `budget` is omitted (default 8000, clamped to the chosen model's max — #125). The router uses whichever is configured (OpenRouter default, Ollama override for sensitive/local). An MCP tool **cannot** see or use the calling agent's own model or credentials, so there is no "use the caller's model" path. **If no transform provider is configured, `output: summary` degrades to `output: raw`** (clean resolved content, no LLM) and provenance records `transform: { provider: "none", reason: "unconfigured" }`. If a configured transform fails, the core returns raw content with `transform: { provider: "none", reason: "transform_failed" }` and a structured transform error such as `transform_provider_failed`, `extract_invalid_json`, `extract_schema_invalid`, or `transform_truncated` (non-fatal — the summary was cut at the model's output ceiling after budget escalation). `transform.reason` (when `provider: "none"`) is a **typed enum `TransformReason`**: `unconfigured` | `unsupported_provider` | `provider_unconfigured` | `model_unavailable` | `no_model_fit` | `sensitive_content_no_local_provider` | `transform_failed` | `schema_validation_failed` — the degrade cause (`unconfigured` = no provider configured; `unsupported_provider` = a caller `transform.provider` override captatum doesn't recognize; `provider_unconfigured`/`model_unavailable`/`no_model_fit`/`sensitive_content_no_local_provider` from the model router when no candidate could be picked; `transform_failed` = the provider ran and threw; `schema_validation_failed` = the extract output failed schema validation, normally caught earlier at the input boundary). Every `provider: "none"` is a degrade, so `status` is `partial` whenever `transform.provider === "none"` regardless of the specific reason. When a summary/extract degrades to raw, the receipt also carries `outputRequested` (the requested output) alongside `output` (the actual, `"raw"`) so the degrade is visible without diffing against the request (#153). **The fallback is token-safe:** when the transform did not produce a summary, the returned `result` is bounded to a ~3000-char excerpt with a note (the full page is still available via `output: "raw"`) — a failed summary never dumps the entire page into the agent context. The OpenRouter adapter retries once on an empty/error completion (transient upstream capacity) before the router demotes to the next candidate model, and surfaces OpenRouter's real inline error (top-level `error`, per-choice `error`, `finish_reason`) instead of a generic "empty completion", so the failure reason is visible in `warnings`. **Model fallback is silent on success (#82):** when the primary model (e.g. `deepseek/deepseek-v4-flash`) fails and the router produces the summary with a later candidate, the user-facing receipt is clean — `status` stays `pass`, no warning. The failed-primary list rides on `transform.fallbackFrom` (visible via `debug:true` and the audit log's `transformFallbackFrom`), so the operator still sees flakiness. An all-models-fail still surfaces honestly as `partial` + a `transform_provider_failed` warning. To reduce the prompt size that was failing the primary model on large pages, `articleBody`/`description` are stripped from the JSON-LD fed to the transform (they duplicate the body text already in the input); the body itself is unaffected. The default is **provider-conditional** (`summary` with a provider, `raw` without), so a missing provider no longer silently degrades a default call — it honestly returns `raw` (requesting `summary` explicitly with no provider still falls back to `raw` + the bounded excerpt above).

## OAuth (hosted flavor only)

Auth is **conditional on deployment flavor** (see Deployment). Two flavors:
- **Hosted remote server** (primary) — requires the gateway-owned OAuth below, so it can serve web agents (claude.ai, chatgpt.com) and shared users.
- **Self-contained local binary** — runs without auth for a single agent/user on one machine.

The OAuth contract below applies only to the hosted flavor. captatum's hosted OAuth is powered by the **mcp-sso** library (`mcp-sso@0.3.2`, acartag7/mcp-sso) — captatum's own OAuth 2.1 / DCR / PKCE / Cloudflare-Access stack, extracted + hardened into the owner's OSS library; captatum dogfoods it as its reference production consumer. The mechanics (DCR/PKCE/consent, token sign+verify, JWKS, AS/PRM metadata, the OAuth-state store + replay/rotation) live in the library; captatum owns its scope policy (`fetch:read`/`fetch:transform`), bounded SQLite deployment adapter, and the hosted-vs-local flavor boundary.

Hosted Captatum enables mcp-sso's Client ID Metadata Document (CIMD) support.
RFC 8414 authorization-server metadata therefore includes
`client_id_metadata_document_supported: true`. A connector that supports CIMD
may use an admitted `https://` metadata-document URL as its `client_id` without
first creating a stored registration. The existing
`registration_endpoint: <issuer>/oauth/register` remains advertised and stored
DCR remains enabled as the fallback for clients that do not support CIMD.
Enabling CIMD does not relax DCR redirect policy and does not turn an arbitrary
URL into a stored client record.

CIMD resolution is mcp-sso's guarded auth-egress path, not Captatum's page-fetch
path. The presented `client_id` is untrusted: production accepts only the
library's closed HTTPS URL grammar, resolves and validates every address before
an IP-pinned TLS connection, refuses redirects, requires a bounded JSON
response, and exact-matches the document's `client_id` and requested redirect.
The default document-size, wall-clock, cache, global in-flight, and per-fetch
waiter caps remain the mcp-sso `0.3.2` defaults. Captatum's real auth limiter
admits at most 120 `authorize:` attempts per source per minute and, separately,
10 `cimd:` resolutions per source per 10 minutes. Both keys are supported
explicitly and fail closed; a missing/unknown prefix is not silently admitted.
Resolution failures are direct OAuth failures and never fall through to stored
DCR under the same URL-shaped `client_id`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | AS metadata |
| GET | `/.well-known/oauth-protected-resource` | Protected-resource metadata |
| GET | `/oauth/jwks` | Public JWKS (`cache-control: public, max-age=60`) |
| POST | `/oauth/register` | Dynamic Client Registration |
| GET | `/oauth/authorize` | Prepare consent; set signed consent cookie |
| POST | `/oauth/authorize/approve` | Verify consent token; issue single-use auth code; 302 `?code=&iss=&state=` |
| POST | `/oauth/token` | `authorization_code` / `refresh_token` / `client_credentials` grant (`cache-control: no-store`) |
| POST | `/oauth/revoke` | Revoke refresh-token family; always 200 |

Flow: authorize (PKCE S256, request-bound signed consent token) → approve (single-use code, stored as `sha256(code)`) → token (verify PKCE, issue **ES256 JWT** access token signed by `OAUTH_SIGNING_PRIVATE_JWK`, aud=resource; rotating refresh tokens stored as `sha256(raw)`, grouped by family; replay revokes the family). Auth-code TTL is 300 s, access TTL 600 s, and refresh TTL 30 days. Hosted DCR is stored, not stateless: interactive registrations and out-of-band machine clients use the persistent SQLite `ClientStore`. Before the first v0.20.0 listener opens, the auth database transactionally records the `stored-dcr-v1` migration marker and, in the same transaction, deletes all legacy authorization codes, refresh tokens, and refresh families. A recorded marker makes later restarts a no-op. mcp-sso generation `1` distinguishes grants created by the current stored-DCR runtime from `NULL` legacy grants created before cutover or by a rolled-back binary; generation is checked atomically when a code is consumed or a refresh token rotates, and both the family and token generation must match. Existing interactive clients register once again, then genuine current-generation sessions survive restarts.

Headless callers use mcp-sso's `client_credentials` extension. Machine clients
are managed only by the operator CLI inside the gateway image:

- `provision <name> <scope...>` creates a machine client;
- `rotate <client-id> [grace-seconds]` replaces its live secret;
- `disable <client-id>` leaves an auditable disabled tombstone and removes all
  accepted secret hashes;
- `list` emits only safe identifiers, names, scopes, versions, and status so an
  operator can recover after an output-channel failure.

There is no HTTP provisioning endpoint and open DCR cannot create a machine
record. Provision validates a non-empty scope ceiling against Captatum's live
catalog. A machine record is versioned; provision is an insert, while rotate and
disable are compare-and-swap updates. The client mutation and its required
metadata-only durable audit row commit in the same SQLite transaction or neither
does. Concurrent rotations therefore have at most one successful CAS; a losing
rotation fails before its newly generated secret can reach stdout. Rotation
keeps at most two active hashes, defaults to 300 seconds of overlap, and rejects
any grace above the hard 600-second maximum.

The raw credential appears once on stdout only. Required durable audit rows and
best-effort stderr diagnostics never contain the secret or its hash. stdout and
stderr write, synchronous rejection, EPIPE, callback, backpressure,
flush, and terminal-close paths are handled without uncaught exceptions or
hangs. A non-evented injected writer must declare either synchronous completion
or callback completion explicitly; function arity is never treated as a
capability signal. For callback completion, the callback is authoritative and a
`false` return is backpressure, not failed delivery. A stderr failure does not reverse
an atomically committed mutation and does not turn a successfully delivered
stdout credential into an ambiguous failed command; the durable SQLite audit is
authoritative. Because a stdout failure can occur after a transaction commits,
a credential-output failure triggers a compensating CAS disable bound to the
exact mutation version whose secret was being emitted. It can never re-read and
disable a newer concurrent rotation. When compensation succeeds, `list` shows
the tombstone and `provision` creates the replacement. If the version conflicts
or the disable fails, the command returns a distinct failure and instructs the
operator to use `list` then `disable`; no raw database surgery is needed.
Database-close failure is likewise non-throwing with respect to already emitted
bytes but produces a non-zero command result.

Captatum enables `clientCredentials` only with stored DCR and advertises
`client_credentials`, `client_secret_basic`, and `client_secret_post` through
RFC 8414 metadata. Machine grants mint no refresh token: a caller caches the
600-second access token, renews with its durable client credential before
expiry, requests only its provisioned scope ceiling, and treats token/auth
failure as closed. Disable rejects all later token exchanges immediately.
Already-issued stateless bearer JWTs are not recalled and remain usable only
until their original expiry, at most 600 seconds after issuance.

The hosted auth routes use a fail-closed per-source fixed-window limiter with
separate surface keys: at most 10 `register:` attempts per 10 minutes, 120
`authorize:` attempts per minute, 10 `cimd:` resolutions per 10 minutes, 120
`token:` attempts per minute, and 30 per minute on each of `revoke:` and
`approve:` (captatum-enforced at the Fastify layer for the two OAuth POSTs the
library adapter leaves unthrottled). OAuth-route request bodies are capped at
64 KiB pre-auth (declared Content-Length rejected with 413 before parsing;
chunked bodies bounded by the same per-route limit), and Fastify request-body
errors surface as their real 4xx (`invalid_json` 400, `payload_too_large` 413,
`unsupported_media_type` 415) instead of a collapsed 500. The shared in-memory map is bounded to 4096
keys; an unavailable, malformed, or unknown surface key is rejected. Hosted
boot requires a non-empty
`CAPTATUM_TRUSTED_PROXY_CIDRS` IP/CIDR allowlist and a 43-character base64url
`CAPTATUM_PROXY_AUTH_SECRET` generated from 32 random bytes. Fastify accepts a
forwarded client address only when both the socket peer is allowlisted and the
request carries a timing-safe-valid `X-Captatum-Proxy-Auth` value. The gateway
removes that internal header from both parsed and raw/distinct Node header views
before route dispatch. The authenticated forwarding envelope is the closed set
`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
`X-Forwarded-Port`, `X-Real-IP`, and `CF-Connecting-IP`. Missing, duplicate, or
incorrect authenticators on a request carrying any member are rejected before
OAuth/MCP dispatch with HTTP 400 `{error:"invalid_proxy_auth"}`; every member is
also removed from parsed and raw/distinct views on rejection. This holds even
when an untrusted co-tenant shares the proxy's socket address; it does not make
sharing the gateway network namespace with a browser safe. A direct request
with no forwarding envelope stays in its socket peer's single bucket. The
Cloudflare edge must overwrite the authenticator with a static secret on the
Captatum hostname; a caller-supplied value is never preserved. Docker Compose
pins the host bridge peer used by its published loopback port instead of
assuming that the container sees host loopback. CIDRs are bounded to IPv4
`/24`-`/32` and IPv6 `/64`-`/128`;
universal and broad private-network ranges are boot rejections. This keeps
Internet callers in independent registration/token buckets without letting a
client-controlled header or an untrusted co-tenant select a bucket. The SQLite adapter independently
enforces hard transactional storage caps of 1024 total clients, at most 1008
interactive clients and at most 16 **active** machine clients. Disabled machine
tombstones still count toward the total cap. New rows beyond a cap are rejected
deterministically while updates and lookups for existing clients keep working.
A successful validated lookup refreshes an interactive client's last-used
timestamp. Boot and the five-minute maintenance loop delete only interactive
registrations unused for 30 days; machine records and their disabled tombstones
are never removed by this sweep. The backend cap, not the rate limiter, is the
final storage bound.

The mcp-sso `Bridge` + Fastify adapter serve this flow end-to-end
(`registerOAuthRoutes`). Hosted production boot is fail-closed:
`OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` +
`OAUTH_SIGNING_KEY_ID` + a non-empty `OAUTH_REDIRECT_ALLOWLIST` +
non-empty `MCP_ALLOWED_ORIGINS` +
non-empty, valid `CAPTATUM_TRUSTED_PROXY_CIDRS` +
valid `CAPTATUM_PROXY_AUTH_SECRET` +
`OAUTH_ISSUER` (absolute `https`) + `OAUTH_RESOURCE` (absolute URL) are
validated by mcp-sso's `createBridgeConfig` (EC P-256 key shape, ≥32-char
consent secret, https origins, valid TTLs, scope subset). Missing, empty, or
whitespace-only values are rejected; no security selector is converted to an
optional value. Captatum's pre-store configuration validation also enables and
validates the literal `cimd: { enabled: true }` block, so an incompatible
mcp-sso CIMD contract aborts before the SQLite state directory or files are
created. Captatum adds its
AUTH-1 gate that the hosted flavor MUST sit behind Cloudflare Access
(`CF_ACCESS_ENABLED=true` + `CF_ACCESS_AUDIENCE/CERTS_URL/ISSUER`, the JWKS
URL https) — so the OAuth subject is always a real verified identity, never a
placeholder. mcp-sso's Cloudflare-Access identity port verifies the
`Cf-Access-Jwt-Assertion` (RS256 against CF's public JWKS, aud/iss/exp + email
presence); the email allowlist is enforced by the CF Zero Trust Access app
policy, with optional `CF_ACCESS_EMAIL_ALLOWLIST` as defense in depth.

Scopes: `fetch:read` (default), `fetch:transform` (to use the Transform stage). Tool handlers enforce required scope per request using the **resolved** output (with the provider-conditional default applied): an effective `raw` call requires `fetch:read` even if it carries an unused `transform` override; an effective `summary`/`extract` call requires `fetch:transform`. So a zero-config call with no provider (resolves to `raw`) needs only `fetch:read`.

## Security controls (see threat-model.md)

- OUTBOUND rebinding-proof `guardedFetch`: scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs and strip credentials from all sanitized URL values; resolve → `isPrivate` CIDR (v4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 incl. metadata, 0.0.0.0/8, 100.64/10, 224/4; v6 ::1, fe80/10, fc00/7, ff00/8, `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible) → connect to the resolved IP (`node:https` with `servername`/`Host` = original host); manual redirects re-validated each hop (`maxHops=5`); decompressed-byte cap; `AbortController` timeout.
- INBOUND: SDK transport Host/Origin DNS-rebinding protection.
- TIER-3 in-browser SSRF: interception is installed at the **context** level (`context.route`), covering every page in the render context — popups included, which page-level routing leaves egressing browser-direct; popups are additionally **closed on sight** (`popup-closed` action). **every non-aborted GET — and a first-party POST (same registrable domain, fetch/XHR only — #111) — is fulfilled through `FetcherPort`** (`route.fulfill`, never `route.continue`) so the browser makes no direct egress — connections are IP-pinned and every redirect hop is re-validated (`maxHops`, and a POST's method/body apply to the initial hop only); image/font/media/analytics URLs are P1 URL/DNS private-IP checked and aborted; websocket-close; SW off; downloads blocked; WebRTC transport egress: non-proxied UDP forbidden by flag (load-bearing on the local flavor's headless-shell launcher; measured inert for STUN-to-server UDP on full Chromium — the hosted sidecar — where the Pod-netns firewall is the control) + every browser TCP connection (TURN included) routed to a refusing loopback proxy; render-byte cap (advisory truncation); browser in a separate process/container with no secret-bearing env — in-process launch keeps the OS sandbox ON (`chromiumSandbox` default true), and the hosted path uses a distinct browser workload and network namespace over CDP (`CAPTATUM_BROWSER_CDP_ENDPOINT`) where `--no-sandbox` is acceptable (container-isolated). The production browser Pod has no secrets or Linux capabilities and accepts CDP only from the gateway Pod. Before browser startup, a trusted init container replaces the Pod network namespace's IPv4 and IPv6 OUTPUT chains with default-drop rules that allow only loopback and established replies; Kubernetes NetworkPolicy is ingress-only because the production kube-router does not enforce external egress denial. The browser cannot share the gateway/cloudflared network namespace: otherwise a compromised browser could bind a temporarily free gateway port and receive the edge authenticator. The browser never runs in-process with `--no-sandbox` against the gateway. The first-party POST gate is PSL-aware (`isSameRegistrableDomain` via `psl`), POST-only, header-allowlisted (Content-Type only — never Cookie/Auth/Origin/Referer/Content-Length), body-capped (`CAPTATUM_RENDER_POST_MAX_BYTES`, never truncated) + concurrency-capped (`CAPTATUM_RENDER_POST_CONCURRENCY`), and the body is counted against the essential render-byte pool at dispatch and released on reject so N rejected POSTs cannot blow the pool. A same-registrable cross-origin POST (e.g. a page on developer.atlassian.com POSTing to api.atlassian.com) triggers a Chromium CORS preflight (`OPTIONS`) + a CORS check on the response; captatum synthesizes a permissive first-party preflight response (204 + `Access-Control-Allow-Origin: *` + allow-methods/headers) and adds `Access-Control-Allow-Origin: *` to the forwarded POST response, so the in-render browser admits the cross-origin exchange (captatum is its own controlled fetcher, not a real cross-origin client the upstream must authorize; the POST is already first-party-gated and carries no credentials).
- Response guards: stream through a counting reader that **truncates** at `maxBytes` (advisory `truncated` flag, not a hard reject) — Content-Length is attacker-controlled so a pre-check would only stop honest oversized servers; the streamed cap is the real backstop.
- Logging: allow-list only (tier, finalUrl, platform, status, bytes, timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize logged URLs to scheme+host when host is private. Per-call audit event.
- Concurrency: a process-wide `AdmissionLimiter` (`MAX_CONCURRENT_MCP=8`) bounds concurrent tool **executions** on hosted (one slot per single-fetch call, one slot per whole `captatum_bulk` call). The single-URL `guardedFetch` is otherwise stateless (no per-host throttle, no in-flight dedupe at the fetcher). `captatum_bulk` adds its own in-orchestrator bounds — `maxConcurrency` (global fetch pool within a call) + a union-keyed per-host token-bucket gate (`maxPerHostInflight` + `crawlDelayMs`) + the BulkGuard caps; a process-wide **global** fetch-concurrency cap across all callers (`LimitingFetcher`, PR 3) wraps the hosted `FetcherPort`, and a per-tenant `BulkQuotaPort` bounds cross-call amplification (see "Tool: captatum_bulk" / "Hosted amplification controls").

## Storage

OAuth state only (auth codes + refresh tokens, hashed) plus stored DCR/machine-client
records and metadata-only client-lifecycle audits, behind mcp-sso's `StorePort`
and Captatum's deployment `ClientStore` adapter:
- **Hosted flavor → SQLite (DEFAULT)** via two independently owned `node:sqlite`
  files in one private Captatum state directory. Existing deployments remain
  compatible: `CAPTATUM_SQLITE_PATH` still names mcp-sso's OAuth file (default
  `./data/captatum.sqlite`), its parent becomes the state directory, and Captatum's
  `ClientStore` uses the derived sibling `<path>.clients`. Before mkdir/open, every
  existing state-path component must be a real directory (no symlink or non-directory
  component); an existing state directory must already be mode `0700` and owned
  by the running effective UID/GID. Missing components are created explicitly as
  `0700`. Both opened database files must be regular non-symlink files at `0600`,
  owned by that same UID/GID; equal/hard-linked inode aliases are rejected again
  after open as defense-in-depth. Separate files prevent cross-store writer lock
  contention. `:memory:` is paired test mode only. `node:sqlite` exposes no
  atomic no-follow open, so these checks do not claim absolute TOCTOU prevention:
  a same-UID process able to mutate the private directory is already inside the
  OAuth-key trust boundary. No external database server is needed.
- **TiDB/multi-replica is deferred for the v0.20.0 auth transition.**
  `TIDB_HOST` remains the sole backend selector; any non-empty value is a
  pre-side-effect boot rejection. With no host, the historical inert template
  defaults `TIDB_PORT=4000`, `TIDB_DATABASE=captatum`, and
  `TIDB_USER=captatum_rw` are accepted and ignored so existing SQLite
  deployments upgrade without editing old environment files. Any other
  non-empty TiDB value, including credentials or CA material without a host,
  is rejected as a partial configuration. Reintroduction requires an explicit
  SQLite-to-TiDB transfer, a distributed CAS/serialization implementation for
  every client mutation, the same bounded-retention semantics, and real
  multi-replica restart/rotation tests.
- No fetched content/body/cache rows are stored; the service is stateless
  otherwise.

Tables owned by mcp-sso: `oauth_auth_codes` (code hash, client id, subject, redirect URI, resource, scopes JSON, PKCE challenge, expiry, nullable grant generation), `oauth_refresh_tokens` (token hash, family id, previous token hash, client id, subject, scopes JSON, expiry, consumed timestamp, nullable grant generation), and `oauth_refresh_token_families` (family id, revoked timestamp, nullable grant generation). Captatum adds `captatum_schema_migrations` to the auth file and, in the client file, `oauth_clients` plus append-only `oauth_machine_client_audit`. `oauth_clients` contains primary-key client id, application type, redirect URI JSON, issued and last-used epochs, optional name, allowed-scope JSON, secret-record JSON, lifecycle status, mutation version, and updated epoch. Every row is parsed into the full closed client domain before return: client-id namespace, application type, redirect policy, arrays, epochs, lifecycle state, versions, and hashes are all checked. A policy-invalid or corrupt row maps to `null`, so authorization/token handling returns `invalid_client` rather than 500. DCR save is insert-only for a new id and permits only an identical existing registration; machine mutations are versioned insert/CAS operations. No path stores a raw secret.

The `stored-dcr-v1` migration transaction creates its marker table if needed,
deletes legacy auth codes/tokens/families, then inserts the marker. A failure
rolls the whole transaction back and aborts boot. The final stored-DCR
`BridgeConfig` HMAC-derives a versioned consent/flow secret from the validated
operator secret, invalidating browser-held pre-upgrade consent and upstream-flow
JWTs without changing the ES256 access-token signing key. The mcp-sso SQLite
migration adds nullable `grant_generation` columns with no SQL default. Current
stored-DCR writes explicitly stamp generation `1`; an old binary's fixed-column
inserts therefore remain `NULL`. Code consumption burns a legacy/non-current
code while returning `invalid_grant`. Refresh rotation checks the family and
token generations inside the same transaction before consuming the
predecessor or inserting a successor; a legacy successor inserted into an
otherwise-current family is also rejected. Prior-scope accumulation filters
both generations. Auth codes are otherwise deleted on first consume whether
valid or expired. Refresh rotation atomically marks the old token consumed and
inserts the next hashed token; replay of a consumed token revokes the whole
family. Consumed refresh tokens are retained until their whole family is past
validity and then swept; orphaned families are cleaned once no token remains.
Captatum keeps a five-minute loop over OAuth expiry plus stale
interactive-client retention. No raw codes/tokens and no fetched
content/body/cache rows are stored.

## Contract fixtures

Stable local contract examples live under `test/fixtures/contracts/` and are
checked by `test/contract-fixtures.test.ts`. They use fake/local fetch and
transform seams; they do not require public internet or secrets.

- `raw-safe.json` — `output: "raw"` success. MCP text starts with the provenance
  line and `structuredContent.output` is `"raw"`.
- `summary-fallback.json` — `output: "summary"` is requested explicitly with no
  provider configured, so the shipped behavior falls back to raw content and
  records `transform: { provider: "none", reason: "unconfigured" }` (the default
  with no provider is `raw`; this fixture pins the explicit-summary fallback path).
- `blocked-ssrf.json` — guarded-fetch rejection still returns a result-shaped
  payload with `code: 0`, `codeText: "FETCH_REJECTED"`, `tier: "error"`, and the
  original guarded-fetch error in `errors[0]`.
- `render-disabled.json` — an empty SPA shell with `allowRender: false` (the opt-out)
  returns `tier: "render-blocked"` and records the skipped render attempt.

The fixture `structuredContent` field locks the **full domain `Result`** record
returned by the use case (not the lean MCP payload above — see "MCP
structuredContent"). Example from `raw-safe.json`:

```json
{
  "schemaVersion": 1,
  "url": "https://fixture.test/contract",
  "finalUrl": "https://fixture.test/contract",
  "tier": 1,
  "output": "raw",
  "resolvedVia": "tier1-meta",
  "platform": { "adapterId": "generic", "label": "Generic HTML", "detectedFrom": "tier1" },
  "jsRequired": false,
  "code": 200,
  "codeText": "OK",
  "result": "Contract Fixture Captatum fixture body for contract reconciliation.",
  "timings": { "totalMs": 0, "fetchMs": 0 },
  "errors": []
}
```

## Error shape

All HTTP/JSON-RPC errors:

```
{ "error": { "code": "snake_case", "message": "human text" } }   // HTTP
{ "jsonrpc":"2.0", "error": { "code": -32003, "message": "..." }, "id": null }  // auth-failed JSON-RPC (-32003; was -32001, which collides with the MCP SDK's RequestTimeout — see #100)
```

Admission overload is a distinct, **retryable** JSON-RPC error, separate from `InternalError`. For the single `captatum` tool admission path, concurrent-execution capacity (DOS-2) emits exactly `{ "jsonrpc":"2.0", "id":<id>, "error":{ "code": -32050, "message":"captatum: server overloaded — retry later", "data":{ "retryable": true } } }`. The frozen application-agent profile permits no additional `data` member on this path. `captatum_bulk` quota exhaustion also uses `-32050` but is a separate contract variant whose `data` may be `{ "retryable":true, "retryAfterMs":<positive integer> }`. `-32050` is distinct from auth-failed `-32003`. Clients SHOULD back off and retry; the local stdio bridge never emits admission overload. There is no `Retry-After` HTTP header. (#84)

Stable `code` values; `message` may change. Auth failure sets `WWW-Authenticate` to an RFC 9728 `Bearer` challenge built by mcp-sso (`buildUnauthorizedChallenge`) — `Bearer resource_metadata="<PRM URL>", scope="fetch:read fetch:transform"[, error="<invalid_token|insufficient_scope>", error_description="<text>"]` — where `resource_metadata` is the resource origin's `/.well-known/oauth-protected-resource` URL (lets a client fetch the PRM doc and discover the authorization server per RFC 9728), and `scope` advertises the catalog. The `error`/`error_description` attributes are present whenever the `/mcp` request is rejected (a missing **or** invalid Bearer token → `invalid_token`; a verified token that failed a scope check → `insufficient_scope`); the human remedy also rides on the JSON-RPC `message`. (mcp-sso emits the RFC 9728 `resource_metadata` form; the prior captatum-specific `realm="captatum"` form — incl. its realm-only-on-no-credentials distinction — was retired with the in-house OAuth stack. RFC 9728 `resource_metadata` is the more standards-compliant + self-discovering form, and is mcp-sso's canonical behavior.) (#104 evolved)
Tool input validation failures use the same HTTP error wrapper and include
`invalid_input` for malformed tool payloads before any outbound work begins.
Guarded fetch policy reject codes include `unsupported_scheme`, `invalid_url`,
`crlf_url`, `userinfo_url`, `private_address`, `blocked_port`,
`scheme_downgrade`, `redirect_limit`, and `invalid_options`. Transient
guarded-fetch reject codes are `dns_error`, `dns_empty`, `timeout`,
`network_error`, `body_read_error`, and `unsupported_encoding`.
`max_bytes` is advisory rather than a guarded-fetch rejection. Note `body_read_error`
has two roles (#149): a **hard** guarded-fetch reject (a **zero-bytes** total
transport failure — the stream broke before any content arrived) AND a **non-fatal
advisory** entry inside a *successful* `Result.errors` (a mid-read truncation with
partial bytes). (`max_bytes` — Tier-1/Tier-3 cap — and `extract_schema_invalid` —
transform/extract — are non-fatal advisories only; they never hard-reject a fetch.) Input
validation also hard-rejects, before any egress, as JSON-RPC `InvalidParams`
`extract_schema_invalid_pattern` for a `pattern` whose content captatum cannot
safely execute (oversized >128 chars, a likely-catastrophic backtracking shape,
syntactically invalid, or non-string — checked at the same input boundary so
no fetch/LLM spend happens first; pattern EXECUTION against model output is
wall-clock-bounded on a worker thread and fails closed on timeout),
`extract_schema_unsupported_keyword` for an
`output:"extract"` schema using a keyword the validator cannot verify after the six recoverable
root-level Captatum knobs are extracted and warned (`schema_knob_extracted`; allowlist fail-closed;
distinct from the advisory `extract_schema_invalid`; applies to `captatum_bulk`'s uniform
schema too), `extract_schema_too_deep` for a schema whose nesting exceeds the supported
depth (`> 64`; a pre-fetch DoS guard — the walker runs free, before any egress), and
`extract_schema_tuple_unsupported` for a schema using tuple-form `items` (an array — the
validator can only advisory-check tuples, so the unverifiable form is fail-closed at input).
(#153)
For `body_read_error` specifically: when the response body stream breaks **mid-read
after partial bytes arrived** (premature close / Content-Length mismatch /
decompression truncation), `readCappedBody` returns those partial bytes with
`truncated:true` + `truncatedReason:"body_read_error"` rather than discarding them
— partial content > none — and the result surfaces a non-fatal `body_read_error`
warning (tier 1, status `partial`). The partial is flagged like a cap truncation so
an agent never treats transport-unreliable bytes as complete/public:
`access.gated:true`, `gateReason:"byte_cap"` (classifyAccess), and the provenance
comment carries `truncated=body_read_error` (model-visible for every output mode,
incl. raw). A single-fetch call also retries the Tier-1 fetch **once** on the
zero-bytes total `body_read_error` reject — bounded by `< 2 × timeoutMs` (each
attempt is bounded by `timeoutMs`; default 15 s → < 30 s, inside the MCP client
window; a caller that raises `timeoutMs` toward its 60 s cap should note the retry
can approach ~120 s). `captatum_bulk` does NOT add this retry — its orchestrator
cannot reserve a transparent in-`execute` retry's egress against the byte cap, so
the bulk egress bound stays airtight (a bulk seed still returns its mid-read
partial via `readCappedBody`, or fails cleanly on a zero-bytes total failure). The
`tier`/`code` distinguish the two roles — advisory entries never set `tier:
"error"`.
`captatum_bulk` per-seed failure codes (one `fail` entry in `BulkResult.failures`,
not a tool-level error — partial failure is normal): `bulk_per_host_cap`,
`tier2_board_not_supported_in_bulk`, `ashby_embed_not_supported_in_bulk`,
`bulk_deadline_exceeded`, `bulk_budget_exceeded`. Tool-level errors for bulk are
limited to input validation (`invalid_input` / `invalid_url` / `bulk_urls_empty` /
`too_many_urls` / `extract_schema_unsupported_keyword` / `extract_schema_too_deep` /
`extract_schema_tuple_unsupported` / `extract_schema_invalid_pattern` — for an
unsupported-after-recovery, too-deep, tuple-form, or unsafely-executable
(invalid/heuristic-flagged/oversized `pattern` content) extract schema), auth,
admission `OverloadedError` (`-32050`),
`bulk_quota_exceeded` (retryable), and `bulk_quota_store_error` (fail-closed).
`bulk_render_cap_exceeded` and `bulk_retried_429` are per-seed WARNINGS (the seed
runs degraded), not fail codes.

## Audit event

One per tool call: `{ occurredAt, subject?, clientId?, tool:"captatum"|"captatum_bulk", bulkId?, url_host (scheme+host only), tier, platform, output, status, bytes, durationMs, transformProvider?, transformModel?, transformCostUsd?, transformInTokens?, transformOutTokens?, transformFallbackFrom? }`. OAuth transitions also write metadata-only auth events: `{ occurredAt, event, status, clientId?, subject?, resource?, scopes?, redirectHost?, reason? }`. Never includes body, full URL path/query for private hosts, authorization codes, refresh tokens, access tokens, consent tokens, or credentials. `captatum_bulk` emits **per-seed** events (one per seed, `tool:"captatum_bulk"` + `bulkId` + per-seed `url_host`/tier/bytes/transform cost; the body allow-list is unchanged) PLUS one **summary** event (`bulkId`, no per-url body) carrying the run totals and `capBreaches` — so spend and SSRF traceability are preserved per seed while total ingest stays bounded.

## Deployment

The repo ships two deployment-flavor runtimes off one core engine:
- **Hosted remote server runtime**: Streamable HTTP `/mcp` + gateway OAuth,
  implemented by `src/server.ts` / `src/interfaces/http/*` and exercised locally
  by tests and `pnpm run smoke:hosted`. The `.github/workflows/release.yml`
  workflow builds and publishes the gateway and browser images to GHCR on
  a `v*` tag (`ghcr.io/acartag7/captatum`, `ghcr.io/acartag7/captatum-browser`).
  The **gateway image ships no browser binary** — Tier-3 connects to the browser
  workload over CDP (`CAPTATUM_BROWSER_CDP_ENDPOINT`), keeping Chromium out of
  the gateway's blast radius; without it, Tier-3 is `render-unavailable`. In the
  production Kubernetes topology Chromium and its fixed loopback-to-Pod CDP
  relay share a dedicated Pod/network namespace behind a ClusterIP Service and
  an ingress-only NetworkPolicy. A trusted init container installs IPv4 and
  IPv6 default-drop OUTPUT rules before browser startup; neither shares the
  gateway/cloudflared Pod. Default state is
  the local SQLite file pair above (no database server); self-host templates
  (Railway / EC2 / Mac Mini) live in `deploy/`.
- **Self-contained local binary runtime**: the same engine can be compiled (Bun
  `--compile`) into one executable an agent runs locally — no deployment, no
  auth, single-user/single-agent use. (wreq-js native prebuilts bundle
  alongside.) The entrypoint is the stdio bridge
  (`src/interfaces/mcp/stdio-bridge.ts`); under Node the stdio-safe client
  command is `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` (a bare
  process so stdout stays a pure JSON-RPC channel). `pnpm run bridge` must **not**
  be used as the client command — pnpm prints a lifecycle banner to stdout and
  corrupts the protocol stream; use `corepack pnpm --silent run bridge` if a
  package script is required. The binary is built with `pnpm run build:binary`
  (Bun external tool). `build:binary` fails loudly with the exact command to run
  elsewhere when Bun is absent, and never reports success unless the binary was
  actually produced. Local mode still routes every fetch through the same
  guarded-fetch SSRF primitive — "local" is not permission to skip SSRF.
