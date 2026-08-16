# Threat Model

Status: v1 threat model for captatum, a URL-fetcher that may also run a
headless browser = textbook SSRF + sandbox surface. Update before any change to
egress, the browser path, or auth. `docs/contracts.md` §"Security controls" is
the contract reference; this file is the security reasoning.

## Assets

- OAuth signing keys, token hashes, stored client registrations, and machine-client secret hashes (hosted flavor only).
- Raw machine-client secrets exist only in the operator process at provision/rotation output and the caller's secret manager; Captatum never persists or logs them.
- OAuth-state store files — the OAuth SQLite path plus its derived `.clients`
  companion. TiDB is rejected for the v0.20.0 transition release.
- Audit events.
- **Fetched page content is UNTRUSTED DATA, never an asset to protect as
  instructions.** It is treated as hostile text throughout.

## Trust Boundaries

- Browser and agent clients are outside the gateway trust boundary.
- The gateway is the security boundary for scopes and tools.
- A CIMD-capable OAuth client supplies an HTTPS `client_id` that names an
  external metadata document. That value crosses a distinct auth-egress trust
  boundary: mcp-sso, not Captatum's page-fetch stack, admits the raw URL,
  resolves and pins its public IP, performs the bounded TLS request, validates
  the document, and exact-matches identity plus redirect before consent.
- Forwarded client IP headers cross the gateway boundary only when the socket
  peer is in the boot-validated `CAPTATUM_TRUSTED_PROXY_CIDRS` allowlist **and**
  `X-Captatum-Proxy-Auth` timing-safe-matches the 32-byte
  `CAPTATUM_PROXY_AUTH_SECRET`. Cloudflare overwrites that internal header at
  the edge; the gateway removes it from parsed and raw/distinct header views
  before route dispatch. The same gate covers `Forwarded`, every Fastify
  `X-Forwarded-*` authority (`For`, `Host`, `Proto`, and `Port`), `X-Real-IP`,
  and `CF-Connecting-IP`, and removes all of them on rejection. The production
  browser runs in a separate Pod/network namespace from gateway + cloudflared,
  receives no secret, and accepts CDP only from the gateway Pod. A trusted init
  container installs IPv4 and IPv6 default-drop OUTPUT rules inside that Pod
  network namespace before browser startup, because the production kube-router
  does not enforce external egress denial. The browser therefore cannot observe
  the proxy hop, bind gateway port 3000 during a container restart, or originate
  Internet traffic.
- The DEFAULT hosted state is two local SQLite files (`node:sqlite`, no network):
  mcp-sso OAuth codes/tokens at `CAPTATUM_SQLITE_PATH`, and DCR/machine clients at
  the derived `<path>.clients`. The configured path's parent is the private Captatum
  state directory: every existing component is non-symlink and a directory, the
  state directory is `0700`, and both regular files are `0600`; the directory
  and files must be owned by the running effective UID/GID. Separate owned files
  prevent cross-store writer locks. The v0.20.0 release is one hosted replica;
  a non-empty `TIDB_HOST` or any non-legacy partial TiDB configuration is a
  pre-side-effect boot failure. The exact dormant defaults from the previous
  SQLite `.env.example` (`4000`, `captatum`, `captatum_rw`) are inert without a
  host so an existing SQLite deployment does not become an accidental outage.
- The **local-binary flavor has no network trust boundary** — it is single-user /
  single-agent only and runs without auth. It must never be exposed on a network.
  Its entrypoint is the stdio bridge (`src/interfaces/mcp/stdio-bridge.ts`), which
  opens **no network listener** and imports no HTTP server. `assertLocalFlavor`
  makes it fail loudly if pointed at the hosted flavor, so the unauthenticated
  path cannot be re-pointed at a network listener. The reverse is also blocked:
  the HTTP listener path (`src/server.ts` + `createHttpApp`) calls
  `assertHostedFlavor` and **refuses to start under `local-binary`**, so the
  network `/mcp` listener can never be wired to the no-auth local flavor — even
  though `local-binary` is the default when no flavor env is set. Audit/log output goes to
  **stderr** only, keeping stdout as the JSON-RPC channel and avoiding leaking
  metadata into the protocol stream. The local flavor reuses the **same** guarded
  egress primitive as hosted mode — SSRF controls are not relaxed for "local".

## Required Controls

- Authenticate and authorize every `/mcp` request independently (hosted flavor).
  Session IDs are never auth.
- Per-request scope enforcement: `fetch:read` default, `fetch:transform` to use
  the Transform stage.
- Hosted OAuth enables CIMD before any persistent store is opened and advertises
  `client_id_metadata_document_supported: true`; stored DCR and its registration
  endpoint remain available as fallback. CIMD metadata is untrusted and goes
  only through mcp-sso's production-closed guarded resolver: HTTPS/path/control
  admission, full special-use IP denial, DNS pinning, TLS verification,
  redirect refusal, 200 JSON-only response, decompressed-byte and wall-clock
  caps, strict document projection, exact raw `client_id` comparison, and exact
  redirect matching. The fail-closed auth limiter permits at most 120
  `authorize:` attempts per source per minute and, in a distinct bucket, 10
  `cimd:` resolutions per source per 10 minutes before resolution;
  single-flight, global in-flight, per-fetch waiter, and cache-TTL caps bound
  attacker-driven work. Unknown limiter surfaces deny. Only validated
  public-client metadata reaches consent; document-contained URLs are never
  fetched, and document key material is never used for client authentication.
- Machine authentication is opt-in only with stored DCR. Machine clients are
  provisioned, rotated, listed, and disabled out of band through one local
  operator CLI; there is no HTTP provisioning endpoint and open DCR rejects
  machine-shaped registrations. Secrets are 256-bit mcp-sso credentials returned
  once, stored only as timing-safe-verifiable SHA-256 hashes, scope-capped at
  provisioning, and rotated with at most two active hashes. Provision is an
  insert; rotate/disable are versioned CAS updates. Each successful mutation and
  its required durable metadata-only audit row commit in one SQLite transaction.
  Rotation overlap defaults to 300 seconds and is hard-capped at 600. Disable
  clears accepted hashes and blocks future grants; already-issued stateless
  bearer JWTs expire naturally within 600 seconds. The access token carries
  `sub == client_id` plus `gty: client_credentials` and no refresh token.
  Malformed/unknown/policy-invalid rows map to `null`, so mcp-sso returns
  `invalid_client` rather than 500.
- Open stored DCR is bounded twice: a fail-closed per-source limiter permits at
  most 10 attempts per 10 minutes with at most 4096 live limiter keys, and the
  SQLite transaction rejects a new row above 1008 interactive, 16 active
  machine, or 1024 total clients. Disabled machine tombstones count toward the
  total. Valid use refreshes an interactive last-used epoch; only interactive
  rows unused for 30 days are swept. Existing clients remain usable during a
  registration flood. Forwarded addresses are honored only for the conjunction
  of an explicit proxy IP/CIDR allowlist and the edge-injected proxy
  authenticator, so the tunnel does not collapse every public caller into one
  global bucket and a direct caller or compromised co-tenant cannot spoof a new
  bucket.
- The first stored-DCR boot records one durable migration marker and deletes all
  legacy auth codes and refresh families in that same transaction before the
  listener opens. The stored-DCR config also HMAC-derives a versioned
  consent/flow signing secret, so pending pre-upgrade browser consent or
  upstream-flow JWTs cannot mint a new legacy authorization code after cutover.
  mcp-sso additionally stamps stored-DCR auth codes, refresh families, and
  refresh-token rows with durable grant generation `1`. Code consumption,
  refresh rotation, and prior-scope accumulation require that generation;
  refresh checks both family and token inside its transaction. A rolled-back
  older binary omits the nullable columns and therefore creates legacy `NULL`
  grants that fail closed after re-upgrade, including when their client id
  names an existing stored client. Genuine generation-1 sessions survive
  ordinary restarts. A first-cutover failure aborts boot. Legacy access JWTs
  get only their existing 600-second natural-expiry grace.
- Rebinding-proof outbound `guardedFetch` (the single egress primitive):
  - scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs and
    keep sanitized URL values credential-free.
  - resolve → exhaustive `isPrivate` CIDR: v4 `10/8`, `172.16/12`, `192.168/16`,
    `127/8`, `169.254/16` (incl. cloud-metadata `169.254.169.254`), `0.0.0.0/8`,
    `100.64/10`, `224/4`; v6 `::1`, `fe80/10`, `fc00/7`, `ff00/8`, IPv4-mapped
    `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible.
  - connect to the **resolved IP** (`node:https` with `servername`/`Host` =
    original host) so DNS cannot rebind post-check.
  - manual redirects re-validated each hop, `maxHops=5`.
  - decompressed-byte cap; `AbortController` timeout.
- Tier-3 in-browser SSRF: interception is installed at the **context** level
  (`context.route("**/*")` — playwright-renderer.ts), which covers every page in
  the render context **including popups**, and **every non-aborted GET — and a
  first-party POST
  (same registrable domain, fetch/XHR only — #111) — is fulfilled through
  `FetcherPort`** (`route.fulfill`, never `route.continue`) — the browser never
  resolves or connects on its own, so DNS-rebinding and the redirect TOCTOU are
  structurally impossible and every redirect hop is re-validated (`maxHops`).
  **Popups are closed on sight** via the CONTEXT-level page listener
  (`context.on("page")` → close + a `popup-closed` action), which arms every new
  page recursively — a popup's own `window.open` included; a page-level
  `page.on("popup")` listener would observe only the render page's direct
  popups and leave a descendant alive. Page-level routing alone covers only the
  page and its frames, and a
  `window.open`/`target=_blank` target would otherwise egress browser-direct,
  bypassing the guarded fetcher entirely (executed PoC 2026-08-15: five
  uninstrumented connections incl. a loopback navigation from a non-loopback
  opener; regression: `test/integration/popup-egress.test.ts`). Context routing
  guards anything a popup fires before the close lands, so neither layer depends
  on the other's timing. **WebRTC**: both flavors launch Chromium with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` — ICE/STUN is
  transport-layer UDP below request interception, so without the flag a rendered
  page could probe/exfiltrate over UDP (executed PoC: STUN datagrams to a
  loopback listener); the hosted browser pod's netns firewall blocks this too,
  but the local in-process flavor has no such firewall, making the flag
  load-bearing there.
  Image/font/media URLs and known ad/tracker hosts (`src/domain/adblock.ts`,
  a curated OSS-derived apex list) are checked with the same P1 URL/DNS
  private-IP guard and then aborted — the ad script/pixel never loads, so it can
  inject no DOM and exfiltrate no data, and its URL is stripped from Tier-1
  transform content (less prompt noise, smaller egress). Adblock is THIRD-PARTY
  only: the main-frame navigation and the fetched page's own (sub)domain are
  exempt, so a blocklisted vendor apex that IS the requested page (amplitude.com,
  hotjar.com, …) still loads and its own links survive the strip. WebSockets are closed;
  Service Workers are disabled; downloads are blocked; render-byte cap is
  enforced; the browser receives no secret-bearing environment. **Sandbox model: an
  in-process launch keeps the OS sandbox ON (`chromiumSandbox` defaults true —
  `--no-sandbox` in-process is a release blocker). The hosted path instead runs
  Chromium in a separate browser workload connected over CDP
  (`CAPTATUM_BROWSER_CDP_ENDPOINT`, `Dockerfile.browser`, `scripts/browser-sidecar.sh`);
  there `--no-sandbox` is acceptable because the container is the isolation
  boundary. The published gateway image (`Dockerfile`) ships **no browser binary**,
  so in-process Tier-3 is structurally impossible there — a misconfigured hosted
  gateway degrades to `render-unavailable` rather than launching Chromium inside the
  OAuth-key blast radius. Production additionally places the browser in its own
  Pod/network namespace, runs it non-root with every Linux capability dropped,
  and permits CDP ingress only from the gateway Pod. Before either
  browser-boundary container starts, a digest-pinned trusted init container
  flushes both Pod-netns OUTPUT chains, sets them default-drop, and allows only
  loopback plus established replies. The untrusted containers receive no
  `NET_ADMIN` capability, so they cannot relax those rules. A
  no-secret, no-capability relay in that same browser boundary exposes fixed Pod
  port 9223 only to forward into Chromium's loopback-only TCP/9222 listener; it
  has no configurable target and caps concurrent connections. The
  gateway accepts only an HTTP/9222 Kubernetes Service origin with exact
  `<service>.<namespace>.svc.cluster.local` DNS-1123 shape; parsing and
  allowlisting happen before any hosted state side effect. The deployer owns the
  concrete Service name. Loopback CDP is rejected because it recreates the
  shared-network-namespace attack. At connect time the renderer swaps the
  hostname for the address it resolves to (`src/infrastructure/render/cdp-connect.ts`):
  Chromium's DevTools server rejects any request whose Host header is neither an
  IP literal nor localhost (DNS-rebinding protection), so dialing the Service
  DNS name through the byte-transparent relay fails with a bare 500 at
  `/json/version` — an IP-form Host passes the check while kube-proxy still
  routes through the same ClusterIP. The configured endpoint itself keeps the
  validated Service shape; resolution failure fails the render (no fallback).
  This
  prevents both packet sniffing and sibling port rebinding during a gateway restart.
  The cluster node/kernel and principals allowed to mutate the Pod, its labels,
  or ingress NetworkPolicy remain inside the operator trust boundary. Either way the
  browser never runs in-process with `--no-sandbox` inside the gateway's blast
  radius. The context-level route SSRF guard applies identically in both modes.**
- Inbound Host/Origin DNS-rebinding protection via the SDK transport
  (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). Hosted
  mode fails boot unless `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, the exact
  `CAPTATUM_TRUSTED_PROXY_CIDRS` peer allowlist, and the
  `CAPTATUM_PROXY_AUTH_SECRET` are explicit; local mode must stay loopback-only.
- Response guards: reject `Content-Length` > max before reading; stream through a
  counting `TransformStream`.
- Linear HTML extraction (REDOS-5): every element/close-tag/comment/`<style>`/svg-`<text>`
  scanner uses a monotonic close-search cursor (no per-tag rescan to EOS), so an
  unclosed-same-tag flood within the 5 MB `EXTRACT_CHAR_BUDGET` cannot stall the
  synchronous event loop. The byte budget is a backstop, not the primary control; it was
  raised 1 MB → 5 MB so deep-content pages whose article sits late in a large HTML body
  (e.g. Atlassian Jira REST docs, ~2.9 MB with the article at ~2.8 MB) are not beheaded.
  `stripHtmlTags` is quote-aware (#146): it tracks `"`/`'` so a `>` inside a quoted attribute
  value is not a tag terminator (was quote-blind → attacker-controllable Alpine/Vue/Tailwind
  directive JS like `x-init="…if(a>b)…"` leaked into the visible-text feed — content-integrity
  / prompt-injection-adjacent; malformed unterminated quotes fall back to the legacy first-`>`
  so malformed input neither drops content nor leaks markup, ≤~2× per char on the malformed
  tail, still linear). The `prescanMetaCharset` meta-tag-end scan (`src/infrastructure/http/charset.ts`)
  was the same class of quote-blind bug (a `>` in a meta attr could hide the charset → mojibake)
  and is fixed the same way. The no-landmark **main-content container selector** (#165) is a linear
  `findStartTags` scan for a curated ID/class allowlist (`#content`/`#bodyContent`/`#mw-content-text`,
  `#layout-content`, `.entry-content`, …) plus a bounded count of `extractVisibleText` calls
  (candidates are prescored by raw content length — O(1) — and only the top-K run the ~10-pass
  extractor; a per-tag candidate cap bounds the flood surface), so it adds no new REDOS surface.
  The sibling landmark path (`selectMainContentHtml`) has the same N×`extractVisibleText` shape on
  its `<article>`/`<main>` scoring and is left UNBOUNDED: the #118 skeleton-override must find the
  real streamed article wherever it sits, so a candidate cap (attempted: slice by count, then a
  raw-length shortlist) regressed it (codex P2 ×2) and was reverted. That REDOS is body-budget-bound
  (~2.5s at the 5MB cap, pre-existing) — the body cap is the bound. A real fix (a cheap accurate
  text-length proxy, or a DOM-based extractor) is a separate change.
  Content-integrity: scoping to a recognized container drops top-bar/sidebar chrome — the most
  injection-shaped region of a page — from the head of the trusted visible-text feed (same
  improvement class as #146's directive-JS fix). Honest residual: the selector is a heuristic a
  hostile page author can game — the length floor bounds false-positive SIZE, not false-positive
  IDENTITY, so an above-floor wrong container can narrow the feed away from content held elsewhere;
  acceptable because the threat model for reference/doc pages is legitimate-but-noisy authors (a
  hostile author can dominate the feed regardless). Residual: the extract layer remains hand-rolled
  (house rule prefers a proven library); a wholesale replacement is a separate change.
- **renderDiagnostics output-exposure (#154):** on a Tier-3 render-failure outcome the result now
  surfaces `renderDiagnostics` — `renderedBytes`/`domTextLength` (sizes), `egressBytes` (a count),
  `blockedRequests`/`forwardedRequests` (counts), `possibleReason` (a fixed enum), and
  `renderEgressHosts`. Every field is a count/size/enum, EXCEPT `renderEgressHosts` which is a NEW
  host-identifier surface: callers gain the set of registrable domains the page loaded subresources
  from. It is bounded by construction — the output shaper filters to `registrableDomain(h) !== null`
  and redacts IP/single-label hosts to the `[ip-literal]` sentinel, so NO raw IP, path, query, or
  full URL crosses the boundary (the internal `render-egress.ts:19` `registrableDomain(h) ?? h`
  fallback is kept for the bulk union-key gate, but only the filtered copy is surfaced). The host
  SET is ATTACKER-INFLUENCED: a hostile render_empty page chooses its own subresource hosts (it can
  `fetch()` arbitrary hosts), so the surfaced domains are page-chosen — a low-bandwidth covert
  channel + a receipt-bloat vector. It is CARDINALITY-CAPPED at the output boundary (deduped + ≤ 8
  entries + a trailing "(+K more)" count), bounding both the bloat and the channel. There is no
  host/IP redactor in the redaction path; safety is by construction at the extractor boundary.
- **Anti-bot challenge classification (#41, #151) is a narrow curated deny-list of literal
  challenge signatures over an already-fetched body** — it issues NO new request and adds NO
  egress/SSRF surface (it inspects only response headers/body already pulled through the sole
  `guardedFetch` egress). `computeAntiBotEvidence` (`src/infrastructure/http/antibot-evidence.ts`)
  reads the body + selected headers and emits booleans/enums ONLY (never raw attacker-controlled
  strings) to the application layer. Two detections, both ReDoS-safe literal alternations (no
  quantifiers, so worst case is linear in the scan window):
  (1) **vendor challenge-only body markers** (`cdn-cgi/challenge-platform`, `__cf_chl`,
  `_abck`, `px-captcha`, DataDome's `captcha-delivery` CDN, Imperva's
  `incapsula incident id`/`powered by incapsula`) + the `cf-mitigated` header → `gateReason:"captcha"`
  with the vendor in `challengeProvider`. These are **challenge-only signatures, not vendor names**:
  the bare DataDome SDK tag (`js.datadome.co/tags.js`) and the Imperva inline `/_Incapsula_Resource`
  sensor are deliberately EXCLUDED — both ship on every *protected* page, so matching them would
  gate legitimate 200 content (silent content loss — the #44-class FP). Status-INDEPENDENT (a
  challenge interstitial can be served at 200); precision comes from the marker, not the status.
  (2) **a status-gated generic verification-phrase detector** → `gateReason:"bot_verification"`
  (vendor not attributable, `challengeProvider` absent): the phrase set
  (`verifying your browser|checking your browser|verify you are a human`) fires ONLY at status 429/503
  AND when the content type is not JSON, so a legitimate 429/503 content page or a JSON API error is
  not mis-gated (a 200 page with these phrases — e.g. an article about bot-detection — is not gated).
  `captcha`/`bot_verification` take precedence over `http_error` in `classifyAccess` so a 429/503
  wall is named as such. The scan windows differ by where each signal lives: the **vendor markers**
  scan the first 64 KB of the body (they sit in `<head>`/early body; a bounded window keeps the
  per-fetch cost low since markers run on EVERY fetch); the **status-gated phrase** scans the FULL
  body (a phrase can sit deep under a large `<head>` — Vercel's checkpoint buries "verifying your
  browser" ~28 KB in), and because it is gated on 429/503 the common 200 path short-circuits before
  the full-body decode (no per-fetch cost on normal reads). The `CHALLENGE_COOKIE` regex (a single
  `\s*` quantifier, linear) is bounded by the requester's HTTP max-header-size, and a cookie alone
  never gates (`detectAntibotBlock` ignores `hasChallengeCookie`). No bypass is attempted — the wall
  is labeled, not entered.
- **`output:"extract"` schema is untrusted input, validated at the input boundary (#153/#193).**
  The caller-supplied JSON Schema is parsed as DATA (never a directive). Before the supported-keyword
  allowlist (`findUnsupportedSchemaKeyword`, the same `SUPPORTED_SCHEMA_KEYS` set the value validator
  enforces), Captatum recovers exactly six valid root-level fields accidentally merged by a client:
  `budget`, `timeoutMs`, `allowRender`, `debug`, `maxBytes`, and `transform`. It shallow-clones the
  schema, revalidates each value through the ordinary input parser without coercion, and removes it
  from the clone. It applies the value only when the true top-level field is absent; otherwise it
  discards the nested value and emits a distinct, non-fatal `schema_knob_extracted` warning. It never
  recurses into schema properties, and it never recovers URL/output/prompt/schema fields or bulk cost
  knobs; untrusted schema data cannot select a fetch target, output mode, or bulk cost policy. The six
  allowlisted knobs may change their ordinary bounded fetch/render behavior only after field validation.
  Required scope is resolved from the same provider-aware effective output the use case executes: `raw`
  skips Transform (and ignores an unused override) while `summary`/`extract` require Transform scope. The cleaned schema is then checked before
  any fetch/LLM, fail-closed (`extract_schema_unsupported_keyword`, JSON-RPC `InvalidParams`) for
  every remaining keyword Captatum cannot verify (`format`, `contentEncoding`, invalid recovered
  values, and all non-allowlisted tool keys). Allowlist, not blocklist (house rule). The offending
  key AND each property-name path segment are length-capped before they enter the error message, and
  **no schema value is ever echoed**. Pattern **execution** is wall-clock-bounded (worker thread, fail-closed on
timeout): the heuristic compares raw branch text and cannot see semantic
overlap between escape/class forms — `(\s|\x20)+` passes it and backtracks
exponentially in V8 (executed 2026-08-15: 9.2 s on a 28-char value, a
synchronous event-loop stall the admission cap cannot bound; the 8 KiB value
cap bounds input LENGTH, not match TIME). The input boundary additionally
rejects pattern CONTENT (oversized/heuristic-flagged/invalid/non-string)
pre-fetch, so a deterministically-unusable pattern never bills a fetch+LLM.
The same recovery runs once on `captatum_bulk`'s uniform schema;
  its warning is call-level and not duplicated per seed. A defense-in-depth copy remains at the transform seam (`finalize`) — dead in the production call
  graph (normalize always runs first), retained only for a hypothetical direct-`TransformPort`
  caller. **Depth:** the recursive walk carries an explicit `MAX_SCHEMA_DEPTH = 64` and fails
  closed (`extract_schema_too_deep`) on exceed. This is required because the walker is the **more
  exposed** path — it runs **pre-fetch, free to attack** (no egress/LLM cost), unlike `validateAt`
  which is post-fetch/egress-rate-limited; request-body *size* bounds total nodes, not nesting
  *depth* (a <1 MB body of nested objects reaches ~150K depth, overflowing V8's stack). The cap is
  also the chokepoint: a deep schema is rejected at input, so `validateAt` (same exposure) is
  protected for every captatum/bulk path. The implicit bound absent the cap would be V8's
  `JSON.parse` recursion limit (~thousands of levels — a deep body throws `RangeError` at parse);
  a `RangeError` from either path is caught by `callCaptatum`/`callBulk` → `toMcpError` →
  `InternalError` (no crash vector), but the explicit cap removes the free-reachable error.
- Bounded transform generation: every provider call carries a bounded
  `max_tokens`/`num_predict` — the server default (`TRANSFORM_MAX_OUTPUT_TOKENS`,
  2000) when `budget` is omitted, clamped to a 4000 hard cap — so a missing budget
  cannot trigger unbounded paid generation (cost/latency DoS).
- Logging: metadata-only allow-list (tier, finalUrl, platform, status, bytes,
  timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize
  logged URLs to scheme+host when host is private.
- Write an audit event for every tool call.
- Treat fetched content as untrusted data — never instructions (prompt-injection
  control).
- Fetched titles enter both MCP text and structured presentation channels
  through one Unicode-category allowlist. Only `L`, `M`, `N`, `P`, `S`, and
  `Zs` code points survive before a 140-code-point clip; Unicode controls,
  formats (including C1, bidi, and zero-width controls), line/paragraph
  separators, surrogates, private-use, and unassigned code points cannot forge
  a header line or reorder hidden title text. The internal fetched Result stays
  unchanged as untrusted data.
- **`captatum_bulk` fan-out** is bounded per-call by the BulkGuard caps (see the
  "Bulk fan-out (captatum_bulk)" section). The orchestrator composes the single-
  URL use case per seed and **adds no egress path**: SSRF, Tier-3 in-browser, and
  prompt-injection controls are enforced per-seed, unchanged. Amplification is
  fixed at 1 per caller-supplied URL (no discovery/recursion/`depth`).

## Machine-client STRIDE

| Asset | STRIDE | Threat | Required control | Residual |
| --- | --- | --- | --- | --- |
| Raw machine-client secret | Information disclosure / Spoofing | A stolen secret can mint bearer tokens as the machine client. Unlike refresh-token replay, repeated use of a machine secret produces no cryptographic theft signal and cannot identify which holder used it. | Secret is returned once, never logged, persisted only as SHA-256; scope is capped; rotate uses a bounded two-secret overlap and disable clears accepted hashes; access tokens live at most 600 seconds. Operator rotation is the recovery for suspected theft. | Theft remains undetectable until external evidence or operator suspicion triggers rotate/disable. Rotation limits future use but cannot recall bearer JWTs already issued; they expire within 600 seconds. |

## CIMD STRIDE

| Asset | STRIDE | Threat | Required control | Residual |
| --- | --- | --- | --- | --- |
| Gateway network authority and OAuth client identity | Spoofing / Tampering / Denial of service | An attacker presents a crafted URL-shaped `client_id` to reach private services, exploit parser differences, substitute a redirect identity, or consume DNS/TLS/body resources. | mcp-sso owns one raw-string admission and comparison path; resolves all addresses, denies special-use ranges, pins the validated IP for TLS, refuses redirects, bounds time/bytes/concurrency/waiters/cache, validates a closed public-client document, exact-matches `client_id` and redirect, applies Captatum's fail-closed 10-per-source/10-minute `cimd:` budget after its separate `authorize:` budget, and emits metadata-only CIMD audit events. | The gateway intentionally makes bounded outbound HTTPS requests to public client metadata hosts. A public host can stay slow or unavailable; the request fails closed and the connector cannot authenticate until its document is valid and reachable. |
| User consent decision | Spoofing | A malicious public client uses a lookalike domain or misleading `client_name` to trick the user into approving it. | The validated client name is escaped, the exact client identifier is bound into the signed flow, consent is frame-blocked, and the redirect must match the validated document. | Domain lookalikes remain a human-judgment risk; technical validation cannot prove the operator behind a public domain is trustworthy. |

## Auth Limits

- **Library boundary:** the hosted OAuth 2.1 / DCR / PKCE / Cloudflare-Access
  stack is owned by the **mcp-sso** library (`mcp-sso@0.3.2`, acartag7/mcp-sso) —
  captatum's own OAuth, extracted + hardened there. captatum's auth surface is
  reduced to: building a validated `BridgeConfig` from env
  (`src/application/mcp-sso-config.ts`), composing the `Bridge` +
  `RequestAuthorizer` + CF-Access identity + store in `src/server.ts`, mounting
  the Fastify routes (`mcp-sso/adapters/fastify`), and its own scope policy +
  flavor boundary. The token sign/verify, PKCE, consent, replay/rotation, store
  schema, and the CF JWT verification are the library's — a security-critical auth
  implementation maintained once (canonically) rather than as a divergent in-repo
  fork. The local-binary flavor is structurally excluded: it uses a
  `LocalBypassAuthorizer` reachable ONLY from the stdio bridge (no network
  listener), never the hosted HTTP `RequestAuthorizer`.
- OAuth is **only** on the hosted flavor. The local-binary flavor has no auth, so
  it must be single-user/single-agent and never exposed on a network.
- Authorization codes and refresh tokens are stored only as `sha256` hashes.
- Refresh-token rotation keeps consumed token hashes so replay can be detected;
  replay revokes the token family and blocks future rotations in that family.
  Retention is bounded but covers the full family validity window: each rotation
  issues a fresh TTL, so a successor outlives its consumed predecessor — a consumed
  row is retained as long as any family member is still valid (so a stolen-token
  replay can still revoke the family), and GC'd only once the whole family is past
  validity. Orphaned families are cleaned, so the store is not a perpetual accumulator.
- Hosted production boot is fail-closed. mcp-sso's `createBridgeConfig` validates
  `OAUTH_CONSENT_SIGNING_SECRET` (≥32 chars) + `OAUTH_SIGNING_PRIVATE_JWK`
  (EC P-256) + `OAUTH_ISSUER` (absolute `https`) + `OAUTH_RESOURCE` (absolute URL)
  + valid TTLs + scope subset; captatum adds its AUTH-1 gate that the hosted flavor
  MUST sit behind Cloudflare Access. The hosted flavor must not silently generate
  production signing secrets or boot with empty iss/aud; missing/malformed
  injection is a boot failure (an `AuthConfigError`).
- mcp-sso's Cloudflare-Access identity port confirms signature/audience/issuer/expiry
  and email presence; identity allowlisting (which emails may mint a token) is
  delegated to the CF Zero Trust Access app policy — the single source of truth.
  `CF_ACCESS_EMAIL_ALLOWLIST` is an optional defense-in-depth second gate.

## Bulk fan-out (captatum_bulk)

`captatum_bulk` runs N independent single-URL fetches under hard per-call bounds.
It is a 50× egress-amplification surface, so this section is load-bearing — read
it before any change to the bulk path. Contract reference:
`docs/contracts.md` §"Tool: captatum_bulk".

**Per-seed controls are UNCHANGED.** The orchestrator composes the single-URL
use case per seed; it opens no new egress path. The rebinding-proof `guardedFetch`
SSRF guard, the Tier-3 in-browser context-level `route` fulfillment, the
sensitive-content transform gate, and the "fetched content is untrusted data"
rule all apply identically to each seed. A private-IP / redirect-to-private /
loopback seed is blocked per-seed (one `fail` entry, `tier:"error"`,
`FETCH_REJECTED`) — bulk must NEVER widen these.

**Caps mapped to attack classes (cross-domain v1).** v1 is cross-domain (one call
may span N registrable domains), so the per-host caps do double duty — politeness
to a legitimate host AND the directed-DoS bound against a victim:

| Attack class | Bound |
| --- | --- |
| Directed DoS to a victim (count) | `maxPerHostInBulk` (10), **union-keyed on egress hosts** (seed registrable domain ∪ redirect hosts ∪ `finalUrl` ∪ Tier-2-resolved, incl. failed-redirect targets). Pre-egress: truncate each seed domain; post-egress: quarantine (stop dispatching) once a redirect-discovered victim crosses the cap. Honest worst case: a victim is added to the union only after a seed settles, so the redirect-discovery wave (≤ `maxConcurrency` = 4) can push the per-victim SEED count to `maxPerHostInBulk + maxConcurrency` (= 14 worst case; pure-direct floods are tighter at `maxPerHostInBulk` via shaping). Per-victim REQUEST count ≤ that × `maxHops`. See "In-flight discovery overshoot" in contracts.md. |
| Directed DoS to a victim (rate) | `maxPerHostInflight` (2, configurable) token-bucket burst + `crawlDelayMs` (1000, 500 floor) refill, keyed on the SEED registrable domain (the only host known pre-egress — NOT union-keyed). It rate-bounds a victim only when the victim IS a seed domain (direct flood) or a repeating funnel source; a pure cross-domain funnel victim is rate-bounded only by the global `maxConcurrency` (4) semaphore. Union-keyed rate spacing for undiscovered funnel victims is the documented future quarantine hardening. |
| Unbounded crawl | `maxUrls` (50 raw / 10 summary\|extract) total + seed-list-only (no discovery/recursion/`depth`) + per-host count cap. |
| Cross-call amplification (a tenant looping bulk calls) | `BulkQuotaPort` (PR 3, BULK-1) — per-tenant rolling seed-window quota (`quotaWindowSeconds` / `quotaSeedLimit`), fail-closed on store error. |
| Cross-bulk fetch flood (concurrent bulks × `maxConcurrency`) | `LimitingFetcher` (PR 3, BULK-2) — process-wide global fetch-concurrency cap (`CAPTATUM_GLOBAL_FETCH_CONCURRENCY`, default 24) wrapping the hosted `FetcherPort`; single-fetch shares the FIFO pool (may briefly queue under bulk load). |
| Egress amplification (bandwidth) | `maxGlobalEgressBytes` (100 MB), host-agnostic global sum from `result.egressBytes ?? result.bytes` (deep egress incl. Tier-3 subresources — PR 3, BULK-5). Worst-case aggregate is ~120 MB (in-flight overshoot ≤ `maxConcurrency × perSeedMaxBytes` = 4 × 5 MB before the post-seed re-check; a dispatch-time reservation tightens it). |
| Browser time / OOM | `maxGlobalWallMs` (55 s hosted default — the MCP client tool-call timeout window; chatgpt.com's hosted connector + the Claude Code SDK hard-close a call at ~60 s, so a taller wall produces only orphaned partials the client never sees, #148; ceiling 180 s, the hard cap) — fetch-aborting via the `CaptatumContext.signal` + dispatch-level abandonment. The hosted default is raisable toward the ceiling via `CAPTATUM_BULK_MAX_GLOBAL_WALL_MS` (#157); the env is operator/deploy-time config (k8s ConfigMap/Secret), **not request input** — a remote MCP caller cannot set `process.env` — so unset → the 55 s default, a malformed / non-integer / out-of-`[1, 180 000]` value is a boot rejection (fail closed; an operator foot-gun that is immediately diagnosable from the named error, not a remotely-exploitable DoS; the domain clamps to the ceiling as defense-in-depth), so an operator can never widen past the ceiling. `maxRenderedSeeds` (10, PR 3 active) bounds how many seeds may attempt a Tier-3 render per call; the render byte pool bounds per-render subresource bytes. |
| Cost amplification (LLM $) | `maxTransformCostUsd` ($0.50, caller-set + clamped) re-checked after each transform + `perSeedTransformCostUsd` ($0.05) concurrent-overshoot bound + `maxUrls=10` for summary/extract. |

**Union-keyed per-host gate (defeats redirect/Tier-2/render host-evasion).** A
directed attack can spread seeds across N distinct domains that all 302→`victim.com`;
keyed on the seed host these pass trivially. The per-host inflight + count caps are
therefore keyed on the UNION of egress hosts, computed as each seed settles. As of
PR 3 the union ALSO includes the hosts a Tier-3 render loaded subresources from
(`renderEgressHosts`), so a render-path directed victim is bounded too (BULK-3).
This is the cross-domain directed-DoS control.

**Egress-byte accounting honesty.** `maxGlobalEgressBytes` is summed from
`result.egressBytes ?? result.bytes`. For the raw-default Tier-1 path this is the
document bytes (exact). For a Tier-3 render, `egressBytes` is the render's total
network egress (`essentialBytes + bytesFulfilled`), so subresource bytes ARE
counted (BULK-5 resolved). `maxRenderedSeeds` bounds render attempts per call.

**No cross-seed content concatenation.** Per-seed transform isolation is a
contract invariant: one LLM call per seed, never N bodies in one prompt (forbids
any batch-summary mode in v1).

**Consumer-side prompt-injection amplification (Nx dose).** N entries in one tool
result is an inherent Nx injection-dose amplification — a malicious page in seed
A cannot reach seed B's transform, but the consuming AGENT reads all N results in
one context. Mitigations: a server-generated random fence token (never echoable
from page content) frames each entry; per-entry `contentSha256` is an anti-tamper
handle; the server instructions state bulk entries are untrusted data and the
agent must not act on instruction-shaped text across entries. Inherent residual
risk: an agent that executes instructions found in any fetched page is
vulnerable; bulk raises the dose, not the per-page risk.

**Admission accounting.** The bulk call acquires exactly ONE admission slot
(`MAX_CONCURRENT_MCP=8`); the orchestrator holds the UNWRAPPED executor, so
per-seed fan-out takes no slots and `OverloadedError` (`-32050`) fires only at the
bulk-call boundary (retryable, whole-call), never swallowed as a per-seed error.

**Audit.** Per-seed events (one per seed, `tool:"captatum_bulk"` + `bulkId` +
`url_host`/tier/bytes/transform cost; body allow-list unchanged) + one summary
event (totals + `capBreaches`). Spend and SSRF traceability preserved per seed.

## Known Risks

- Tier-3 is the maximal SSRF surface. The in-browser controls are mandatory, not
  advisory; a Tier-3 path that drops any of them is a release blocker.
- The production browser isolation depends on the Kubernetes Pod/network
  namespace boundary, its Pod-netns firewall, and ingress NetworkPolicy. The
  firewall is not the cluster's measured-broken egress NetworkPolicy path. A
  principal that controls the node/kernel, namespace workload labels, or policy
  objects is already inside the deployment trust boundary. A compromised
  renderer may still forge rendered page output, but it receives no gateway
  secret and cannot originate page network egress; fetched content remains
  untrusted regardless.
- **TIER3-POST — page-authored upstream egress (#111).** Tier-3 now forwards a
  first-party POST body (Notion/Jira hydrate via POST), which is untrusted page content
  egressed to a first-party endpoint. A compromised/XSSed page on victim.com could amplify
  crafted POST bytes (up to `CAPTATUM_RENDER_POST_MAX_BYTES` × `CAPTATUM_RENDER_POST_CONCURRENCY`
  permits × concurrent renders) to its own origin's side-effecting/CSRF endpoints. Bounded by:
  the registrable-domain first-party gate (`isSameRegistrableDomain`, PSL-aware via `psl`);
  POST-only (`PUT`/`PATCH`/`DELETE` abort); the header allowlist (only `Content-Type` is
  forwarded — never `Cookie`/`Authorization`/`Origin`/`Referer`/`Content-Length`); the per-POST
  body cap (never truncated); the essential render-byte pool accounting (body reserved at
  dispatch, released on reject); and the per-render POST semaphore. The fetcher still
  SSRF-validates the target IP per hop; the body is bytes on a guard-pinned connection.
- **PSL data lag (#111).** Multi-tenant suffix recognition depends on the pinned `psl`
  release's data. A multi-tenant suffix added to the upstream Public Suffix List after the
  pinned release is not yet recognized, so two tenants on that suffix would be treated as the
  same registrable domain (cross-tenant POST egress within the suffix). Mitigated by: pinning
  `psl` to a 15-day-cleared release bumped in routine refresh; the fetcher SSRF guard still
  validates the target IP per hop; no credentials are forwarded; scope is bounded to one
  registrable domain regardless. `localhost`/IP-literal pages never match (fail-closed).
- **Deployment egress — the datacenter-ASN wall.** A hosted deployment on a cloud
  datacenter IP (AWS/GCP/Azure) loses to a plain residential webfetch on Cloudflare/anti-bot-
  protected sites (Notion, cppreference, npmjs, Cursor): those sites challenge/slow
  **datacenter ASNs**, so captatum's fetch/render fails (`captcha`, `render_empty`, error
  boundary). captatum's TLS fingerprint is HTTP-only (HTTPS has no fingerprint), and the
  challenge is upstream of the fingerprint anyway — the lever is the **egress IP**, a
  deployment property, not captatum code. captatum renders these same sites correctly from a
  residential IP (verified, same Chromium). Mitigated by: deploy on a **residential-IP host**
  (always-on Mac mini / home server) behind a Cloudflare Tunnel — the egress is residential
  and not challenged; the `FetcherPort` SSRF guard is unchanged. Full analysis + evidence +
  trade-offs: [`docs/deployment-egress.md`](deployment-egress.md); deploy guide:
  [`deploy/mac-mini.md`](../deploy/mac-mini.md).
- The Transform router egresses fetched content to OpenRouter. This is acceptable
  for **public** pages. **Non-public content** (authed/signed URLs, internal hosts)
  must route to local Ollama or skip the transform; detection is signal-based, not
  a guarantee. This is the primary data-direction risk. See "Sensitive-content
  detection" below for what is and isn't caught.
- The default `output` is **provider-conditional**: `raw` when no transform provider
  is configured, `summary` when one is. So a missing provider no longer silently
  degrades a default summary into a truncated raw excerpt — the default is honestly
  `raw` (full content, `transform` omitted). Requesting `output: "summary"`
  explicitly with no provider still degrades to `raw` with
  `transform: { provider: "none" }` (a bounded excerpt, not the full page).
- Advisory-only SSRF is unacceptable for the hosted flavor. Every egress path —
  Tier-1, Tier-2, every redirect hop, every Tier-3 document/script/fetch/XHR/
  stylesheet request — must route through enforced `guardedFetch`/context-level `route`
  controls, and aborted Tier-3 body types must still pass P1 URL/DNS private-IP
  checks before being aborted.
- Current Tier-1 HTTPS egress intentionally falls back to the Node requester
  instead of `wreq-js` so checked-IP connect semantics can preserve original-host
  SNI and certificate verification. This keeps SSRF controls intact but means the
  `wreq-js` TLS/JA3+JA4 anti-bot benefit is only active for plain HTTP until an
  HTTPS checked-IP + original TLS identity path is proven.
- Single-node store: the v0.20.0 SQLite file pair is not HA and the release
  intentionally supports one replica only. TiDB returns only with an explicit
  transfer plan, distributed client-mutation serialization, and real
  multi-replica acceptance tests.
- SQLite path-race residual: `node:sqlite` exposes no `O_NOFOLLOW`/caller-fd open,
  so pre-open component checks plus post-open inode/mode checks are defense-in-depth,
  not an absolute no-TOCTOU guarantee. A same-UID process able to swap entries in
  the `0700` state directory is already inside the gateway/OAuth-key trust boundary.
- OpenRouter API-key egress is `https://`-only: a non-loopback `http://`
  `OPENROUTER_BASE_URL` is rejected at provider construction (and the transport
  refuses an authorization header over cleartext http to a non-loopback host), so a
  misconfigured base URL cannot leak the key in plaintext.

- **`captatum_bulk` — per-tenant quota (BULK-1, RESOLVED in PR 3).** A per-tenant
  `BulkQuotaPort` bounds a tenant's aggregate seed throughput across calls: each
  hosted bulk call reserves its seed count against a rolling window
  (`CAPTATUM_BULK_QUOTA_WINDOW_SECONDS` / `CAPTATUM_BULK_QUOTA_SEED_LIMIT`), and a
  reservation that would exceed the window fails the whole call
  (`bulk_quota_exceeded`, retryable). The port is **fail-closed** — a store error
  (or a missing tenant id when a quota port is configured) refuses the bulk
  (`bulk_quota_store_error`) rather than running unbounded, introducing a new
  failure surface (store outage → bulk refused) accepted as the safe direction.
  The default impl is an in-memory rolling window (per-process); a distributed
  store is the multi-instance scale path. The local-binary flavor is single-user /
  unbounded (noop quota port) by design. No separate `bulk:read` scope in v1
  (founder decision 7); bulk reuses `fetch:read` / `fetch:transform`.
- **`captatum_bulk` — global fetch cap across concurrent bulks (BULK-2, RESOLVED in
  PR 3).** A process-wide `LimitingFetcher` wraps the hosted `FetcherPort`:
  `CAPTATUM_GLOBAL_FETCH_CONCURRENCY` (default 24) bounds concurrent `fetchGuarded`
  calls across ALL callers (single-fetch + bulk seeds + Tier-3 render subresources),
  bounding the unbounded worst case (8 bulks × 4 = 32) below the box sizing.
  Single-fetch shares the FIFO pool with bulk seeds (no priority): under heavy
  concurrent bulk load a single-fetch MAY briefly queue, FIFO-fair, rejecting as a
  retriable `timeout` if its `timeoutMs` elapses (no caller hangs on the gate). The
  previously-unbounded 8 bulks × 4 = 32 concurrent fetches is now bounded. Local
  flavor uses the raw fetcher (single-user).
- **`captatum_bulk` — Tier-3 fan-out + the render-path union gap (BULK-3, RESOLVED
  in PR 3).** On a Tier-3 render the browser egresses script/xhr/fetch
  **subresources** through `fetchGuarded` whose hosts never appear in the seed's
  redirect/finalUrl chain — a render-path directed-DoS the seed-keyed union would
  not bind. PR 3 resolves this: render-on-bulk is ALLOWED (`allowRender:true`)
  together with (a) the render's subresource hosts collected per render
  (`renderEgressHosts`) and fed into the post-settle per-host count gate, so a
  render-path victim IS bounded by `maxPerHostInBulk`; (b) `maxRenderedSeeds`
  bounding render attempts per call; (c) the per-render byte pool (a fixed **48MB
  essential cap** + a `maxBytes` non-essential cap, decoupled from `maxBytes` since
  #143 — heavy SPAs ship far more essential JS than one response) bounding per-render
  subresource volume — a post-acquire `isExceeded` re-gate bounds a concurrent request
  burst to N×maxBytes crossing (without it a page bursting M requests egresses M×maxBytes);
  (d) deep `egressBytes` (BULK-5) bounding
  the aggregate; (e) the `LimitingFetcher` global fetch cap bounding concurrency. A
  seed that renders N subresources to `victim.com` counts as one seed touching
  `victim.com` (count bound), with its subresource bytes counted in full.
- **`captatum_bulk` — directed-DoS to a victim is inherent (BULK-4).** Any bulk
  fetch tool can be aimed at a victim host; the per-host count + rate caps bound
  but do not eliminate it. Residual: captatum's egress IPs could be blacklisted by
  an aggressive victim, degrading service for all tenants. Mitigated by polite
  defaults (low concurrency + crawl-delay + per-host gate) and the founder's
  caller-authorizes-ToS stance (captatum is a targeted agent fetcher, not an open
  crawler). robots.txt respect is deferred to the future `captatum_crawl`.
- **`captatum_bulk` — render-subresource egress undercount (BULK-5, RESOLVED in
  PR 3).** The byte cap now sums `result.egressBytes ?? result.bytes`. For a
  Tier-3 render, `egressBytes` is the render's total network egress
  (`essentialBytes + bytesFulfilled`) — subresource bytes ARE counted, so the cap
  is honest on the render path. For Tier-1/Tier-2, `egressBytes` = document bytes.

## Sensitive-content detection

`detectSensitiveTransformInput` (`src/infrastructure/llm/safety.ts`) gates whether
fetched content may egress to a hosted LLM (OpenRouter) vs. routing to a
loopback-only provider or skipping the transform. `localOnly` selects only
candidates whose base URL resolves to loopback (`localhost` / `127.0.0.0/8` / `::1`);
a remote HTTPS `OLLAMA_BASE_URL` yields `local:false`, so flagged content falls back
to raw rather than egressing to it — the "stays local" guarantee is loopback-derived
from the actual URL, not from the provider name. It is a signal-based heuristic, not
a guarantee.

High-confidence signals (still flagged — in the source url AND embedded in content):
- Credential values — PEM private-key headers, GitHub/Anthropic/OpenAI/AWS/Slack/
  GitLab tokens, AWS access-key IDs (`AKIA…`), Google API keys (`AIza…`), JWTs, and
  cloud env-var secret assignments (`AWS_SECRET_ACCESS_KEY=…`, `AWS_SESSION_TOKEN=…`,
  `AZURE_CLIENT_SECRET=…`) matched as `NAME=value` (not a generic "secret=" word,
  which false-positived on pages that merely discuss security).
- Header dumps — `Authorization: Bearer/Basic …` and `Set-Cookie:`, matched
  case-insensitively. Embedded URLs are normalized for HTML-escaped separators
  (`&amp;`/`&#38;`/`&#x26;` → `&`) before the credential-key check.
- Internal hosts — `.local`/`.internal`/`.corp`/`.localhost`/`.priv` suffixes and
  private/reserved IP literals (`isPrivate`, incl. cloud-metadata `169.254.169.254`).
  **Loopback content exemption (#127):** a loopback host (`localhost`/`127.0.0.0/8`/`::1`)
  *embedded in fetched content* is NOT flagged — a README/docs setup example resolves to the
  reader's machine, not a leaked internal endpoint. The exemption is **content-only** (a loopback
  SOURCE url is still flagged — captatum never fetches a loopback target) and **plain-loopback-only**:
  it does not apply when the URL carries a credential anywhere (query key, fragment key, or
  userinfo `user:pass@`), so a loopback OAuth redirect (`…#access_token=…`,
  `http://client:secret@localhost…`) is still flagged.
- RELATIVE credential references in content, in every RFC 3986 form (2026-08-15
  executed gap: `/cb#access_token=…` egressed where the absolute spelling was
  flagged). Two linear scans over the same 500 KB head, neither consuming a path
  (path-length caps were a bypass — a credential after a 2 050-char generated path
  must not egress): (1) a KEY-anchored scan — any `?`/`#`/`&` followed by
  `credential-key=value` flags, wherever the reference starts, with HTML-escaped
  separators normalized; (2) a NETWORK-PATH scan — `//authority` references carry a
  host, so the userinfo/internal-host/loopback checks apply via a dummy scheme,
  and an UNPARSEABLE authority fails CLOSED (an exposed password aimed at a
  private host behind an invalid port must not egress because the parser gave
  up). Network-path references are recognized in their full WHATWG spelling:
  backslash is a separator equal to `/` (a run of 2+ mixed `\/` — `\\host\path`
  and `/\user:pass@host/f` resolve to the private authority exactly like `//`),
  and URL-ignored tab/LF/CR may appear anywhere inside the reference (Node
  strips them from separators and hostnames alike) — all three scans run on the
  whitespace-normalized head, and the `/ \ ? #` terminators keep adjacent
  references from fusing. A third scan covers SCHEME-PREFIXED authorities
  (WHATWG "special relative-or-authority"): a special scheme — `http:`, `https:`,
  `ws:`, `wss:`, `ftp:`, `file:` — followed by ZERO or ONE separator introduces
  an authority when the scheme DIFFERS from the source url's (cross-scheme
  `http:10.0.0.5` and `http:\\pass@10.0.0.5/x` resolve to the private host),
  while the same-scheme form is a path on the current page and is skipped.
  Interpretation of any captured authority is 100% Node's URL parser (IDN,
  Unicode dot variants, IPv6 zones, shorthand all normalize as the browser
  sees them); only the boundaries and the capture are ours. The
  #44 ad-noise carve-out is preserved: only the credential key set flags, never
  generic token/key/auth/expires, and a clean public `//host` reference stays
  unflagged.
- URL-embedded credentials — a url that is itself a credential, matched on the source url AND
  any url embedded in content, in all three locations: QUERY params (cloud presigned signatures
  `x-amz-signature`/`x-amz-credential`/`x-amz-security-token`, `x-goog-signature`, Azure Blob
  SAS `sig`, JWS `signature`, Tencent COS `q-signature`, OAuth/API tokens `access_token`/`api_key`),
  the FRAGMENT (`#access_token=…`, with HTML-escaped `&amp;`/`&#38;`/`&#x26;` separators normalized
  before the key check), and the USERINFO (`user:pass@host`). The fragment + userinfo checks are
  load-bearing for the loopback content exemption — without them a loopback OAuth redirect could
  egress (#127 codex review).

Deliberately NOT flagged (the #44 regression: news pages such as `estadao.com.br`
were mis-flagged, which skipped the transform and silently dumped raw):
- Generic ad/CDN keys (`token`, `key`, `auth`, `expires`) in content-embedded urls —
  ad/CDN trackers abuse these and they are not credentials. The SOURCE url still
  checks all keys (these included): fetching a tokenized url is itself suspicious.
  (`sig`/`signature`/`access_token` are real credentials and stay flagged in content
  — an early #44 draft over-narrowed this; corrected after adversarial review.)
- No path-segment "opaque token" heuristic — it was removed (the second #44
  regression). No length/alphabet rule can reliably separate a real opaque token
  from a long news-article slug (`brasil-japao-ao-vivo-copa-do-mundo-2026-06-29`)
  or a CDN hash, so it caused deterministic false-positives on public articles
  (the source URL is scanned, and the article's own slug matched). Real
  path-embedded credentials are still caught: JWTs by the credential-value
  patterns, presigned URLs by the query-key check, internal hosts by
  internalHostReason. The lost coverage (a non-JWT opaque share-token in a URL
  path) is rare and low-risk (fetching a share URL is user-intentional).
- Large content — there is no longer a fail-closed `content_exceeds_scan_cap`. The
  credential/header patterns scan the FULL content; only the embedded-url scan is
  capped at the first 500 KB (ReDoS/DoS hygiene).

Residual risk: a cloud-presigned URL embedded past the 500 KB scan head could egress
to a hosted LLM. Accepted: such a URL on a genuinely public page is low-likelihood,
and a caller who fetches a presigned SOURCE url is still blocked at the source check.

## Implementation Gates

- No egress or browser-path change without updating this doc.
- No dependency install before `docs/dependency-ledger.md` recheck (15-day rule).
  `pnpm audit --prod` must be clean before public hosted deployment, or any
  finding must be documented in the ledger with why no eligible patched version
  can be selected under the 15-day gate.
- The SSRF fixture suite must all be blocked before the hosted flavor ships:
  `169.254.169.254`, `::ffff:169.254.169.254`, `localhost`, `gopher://`, `file://`,
  `302 → 127.0.0.1`, and a DNS-rebind stub. The fixture list is
  `test/fixtures/security/ssrf-payloads.json`, exercised by
  `test/ssrf-fixtures.test.ts` (Tier-1 guard). The Tier-3 in-browser path has its
  own REAL-Chromium regression — a rebinding subresource, a redirect-to-private
  navigation, and a normal-render sanity — in `test/integration/tier3-ssrf.test.ts`,
  which drives a real Chromium through the fetcher-fulfillment path and asserts the
  browser makes no direct egress.
- No public hosted deployment before `OAUTH_SIGNING_PRIVATE_JWK` injection, the
  one-time stored-DCR SQLite migration, explicit `MCP_ALLOWED_HOSTS` /
  `MCP_ALLOWED_ORIGINS`, and authenticated client compatibility tests pass.
- Tier-3 is **shell-gated**, not unconditional: `allowRender` defaults **true**
  (single-fetch) / **false** (bulk), but a render fires only when Tier-1 extraction
  finds an empty JS shell (`jsRequired`) — a normal content-bearing page never
  spawns a browser. Set `allowRender:false` to opt out (`render-blocked`). The
  JSON-LD that satisfies the shell-gate is restricted to a **data-`@type`
  allowlist** (`CONTENT_TYPES` — `JobPosting`/`Article`/`Product`/`HowTo`/`FAQPage`/…;
  #152, next step — and partial reversal — of #109), not any JSON-LD node: an
  allowlist, not blocklist, at the trust boundary (house rule), so untrusted
  metadata JSON-LD (org/breadcrumb/`WebPage` tagline, a `VideoObject` embed)
  cannot pin a JS-rendered listing page (e.g. a job board) at an empty Tier-1.
  The match is a `Set` lookup on the `shortSchemaType`-normalized `@type` (no
  regex → no ReDoS); the `@graph` + nested-entity recursion is depth-capped
  (`MAX_NESTED_DEPTH = 4`) and object-identity cycle-guarded. The same predicate
  backs the `low_value` exclusion (`content-quality.ts`), tightened consistently.
  The widened Tier-1 harvester reads more untrusted JSON-LD fields per type
  (`step[]`, `mainEntity[]`, `reviewBody`, `recipeInstructions`, …) into
  `result.text`; each pull is length-capped (~4 KiB) and array fields are
  count-capped (first N), values are DATA (string-coerced, linear HTML-stripped,
  never a directive) over the already-prototype-pollution-safe `JSON.parse`
  reviver — bounded untrusted-input extraction, ReDoS-safe.
  `captatum_bulk` allows `allowRender:true` as of PR 3 — the render's subresource
  hosts feed the per-host union count gate (`renderEgressHosts`, BULK-3),
  `maxRenderedSeeds` bounds render attempts, and deep `egressBytes` (BULK-5) counts
  the subresource bytes. The in-process launch keeps the OS sandbox ON
  (`chromiumSandbox` default true); `--no-sandbox` in-process is a release blocker.
  (Cleanup flag: `config.render.allowRenderDefault` is dead — never consumed; the
  live default is `DEFAULT_CAPTATUM_DEFAULTS.allowRender`. Either wire it or drop
  it.)
- **`captatum_bulk` implementation gate (BULK-GATE).** Hosted bulk ships
  (`CAPTATUM_BULK_ENABLED` default ON) once ALL of: (a) BulkGuard unit tests prove
  each cap short-circuits (incl. the union-keyed per-host gate on a redirect-funnel
  fixture); (b) an SSRF bulk fixture (50 seeds: private IPs + redirects-to-private
  + legitimate) asserts ZERO private-IP egress — every private seed is a per-seed
  `FETCH_REJECTED`, never a fetched body; (c) a cross-domain directed-DoS fixture
  (seeds on N distinct domains all 302→victim) asserting the union-keyed count cap
  aborts the overflow; (d) a Tier-3 bulk regression asserting every render
  subrequest routes through `route.fulfill` / `fetchGuarded`, the render's
  subresource hosts feed the union count gate (`renderEgressHosts`), AND
  `maxRenderedSeeds` downgrades the overflow; (e) a global fetch-concurrency cap
  (`LimitingFetcher`) + per-tenant `BulkQuotaPort` have landed; (f) a REAL 50-URL
  run (not a synthetic green fixture) verifying egress-byte accounting and
  wall-clock against the 2 vCPU / 4 GiB sizing (the cerebralvalley render-byte-budget
  lesson). **PR 3 status: (a)–(f) ALL pass.** (e) = `LimitingFetcher` (BULK-2) +
  `BulkQuotaPort` (BULK-1); (d) = render-on-bulk with the render-egress-host union
  (BULK-3) + deep `egressBytes` (BULK-5); (f) re-ran via `src/dev/bulk-probe.ts`
  with `CAPTATUM_BULK_ENABLED=true`. Local flavor has shipped ON since PR 2.
  **Funnel bound (quarantine):** once a REDIRECT-discovered victim (a host in a seed's
  union that is NOT its own seed domain) crosses `maxPerHostInBulk`, the orchestrator
  QUARANTINES — it stops dispatching the remaining seeds (a one-time global pause on
  further dispatch; in-flight seeds finish). This bounds the per-victim SEED count at
  `maxPerHostInBulk + maxConcurrency` (= 14 at the defaults) worst case: a redirect-
  discovery wave can be up to `maxConcurrency` wide (the victim is undiscovered until the
  first funnel seed settles, by which time up to `maxConcurrency` are in flight). Pure-
  direct floods are tighter (`maxPerHostInBulk` via shaping + the pre-egress seed-domain
  check); pure-redirect ≈ `maxPerHostInBulk + maxConcurrency - 1`. Tightening the mix case
  to `+ maxConcurrency - 1` would require quarantining on ANY host reaching the cap
  (including direct), which over-truncates legitimate multi-host bulks — not worth the UX
  cost for one fewer seed at the victim. The per-victim REQUEST count is the seed count ×
  `maxHops` (victim-controlled redirects). A legitimate cross-domain bulk where each seed
  redirects to a DISTINCT destination is NOT quarantined (no host crosses the cap). Residual
  (BULK-4): directed-DoS to a victim is inherent to any bulk tool — these caps bound it to
  ≤ 14 seeds/call, they do not eliminate it; and the quarantine is intentionally coarse (it
  pauses all further dispatch once any victim is discovered, so innocent seeds in the same
  call may also be aborted — the caller retries them).
