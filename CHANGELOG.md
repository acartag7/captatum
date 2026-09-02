# Changelog

## [0.20.2] — 2026-08-16

Security-hardening patch following a full Level-3 adversarial assessment
(executed PoCs against the real deployment). Hosted rendering works again —
v0.20.0 accidentally broke every hosted Tier-3 render at the CDP connection —
and four classes of content-exfiltration and event-loop-stall bugs are closed.

- **fix(render): hosted Tier-3 rendering works again.** Since v0.20.0 every
  hosted render failed at `connectOverCDP` (Chromium rejects non-IP `Host`
  headers); the gateway now dials the browser workload at its resolved address.
  JS-shell pages render again instead of silently degrading to `render_error`.
- **fix(render): the Tier-3 browser can no longer egress on its own.** Popups
  (including popups-of-popups) escaped request interception entirely; every new
  page in the render context is now intercepted and closed on sight. *(Correction,
  2026-09-02: the WebRTC flag added here stops STUN UDP only in the headless-shell
  launcher — the local binary flavor. On the hosted full-Chromium sidecar it is
  inert, and hosted containment rests on the browser Pod's egress firewall — a
  deployment prerequisite this repo does not ship. Without that boundary, leave
  `CAPTATUM_BROWSER_CDP_ENDPOINT` unset; see SECURITY.md.)*
- **fix(safety): credential-bearing references in page content can no longer
  slip past the hosted-LLM egress gate.** Relative URLs (`/cb#access_token=…`),
  any path length, WHATWG backslash spellings (`\\host`, `/\user:pass@host`),
  line-wrapped references, scheme-prefixed forms (`http:10.0.0.5` cross-scheme),
  IDN hosts, and Unicode dot variants are all recognized; malformed references
  fail closed.
- **fix(extract): caller-supplied regex patterns are validated before any
  fetch/LLM spend and executed under a wall-clock budget.** A
  catastrophically-backtracking `pattern` could stall the entire event loop for
  minutes from one request; patterns now run on a worker with a hard budget,
  and invalid ones are rejected at the input boundary.
- **fix(deps): every published advisory closed — `pnpm audit --prod` is
  clean.** find-my-way, fast-uri, hono, @hono/node-server, ip-address, and
  body-parser are pinned at their minimum fixing versions (ledger-mandated;
  the hono exception is recorded per-package with its GHSAs).

Checks: exact-head CI passed syntax, line limits, type checking, the full unit
suite, integration fixtures (real Chromium, including a new popup-egress
regression), and the process guard. Every fix carries a regression test that
fails with the fix reverted; executed attack matrices are preserved in the
assessment vault.

## [0.20.1] — 2026-07-29

Hosted connectors that support Client ID Metadata Documents can authenticate
without a manually configured OAuth Client ID. This patch restores Claude's
hosted sign-in path while retaining stored Dynamic Client Registration for
clients that still use it.

- **fix(auth): enable CIMD discovery.** Hosted RFC 8414 metadata now advertises
  `client_id_metadata_document_supported: true`, and URL-shaped client IDs are
  resolved through mcp-sso's guarded, bounded metadata-document path.
- **fix(auth): admit the complete hosted authorization flow.** Captatum's
  fail-closed limiter now has separate `authorize:` and `cimd:` budgets in
  addition to the existing registration and token budgets. Without these
  allowlisted prefixes, a valid CIMD login was rejected with 429 before the
  metadata document could be resolved.
- **compatibility:** the stored DCR registration endpoint, machine-client
  credentials, 600-second tokens, and stateless JSON `/mcp` contract are
  unchanged.

Checks: exact-head CI passed syntax, line limits, type checking, the full unit
suite, integration fixtures, and the process guard. Focused tests exercise both
stored-DCR fallback and a valid guarded CIMD authorization; both regression
tests fail with their fixes reverted.

## [0.20.0] — 2026-07-28

Headless applications can now authenticate to hosted Captatum without an
interactive browser. This release adds persistent, operator-provisioned machine
credentials while keeping the existing stateless JSON `/mcp` request/response
contract stable for application-agent.

- **feat(auth): machine-to-machine OAuth.** Hosted metadata now advertises
  `client_credentials` and `client_secret_basic`. A scope-capped machine client
  receives a 600-second bearer token with no refresh token and can call the
  existing `captatum` tool.
- **feat(ops): complete machine-client lifecycle.** The container CLI provisions,
  rotates, disables, and lists machine clients. Secrets are returned once,
  stored only as verifiable hashes, rotated with a bounded overlap, and coupled
  atomically to their durable audit record.
- **fix(auth): persistent, bounded stored DCR.** Interactive and machine clients
  survive restarts. Registration storage has a hard capacity, stale interactive
  clients are swept, corrupt rows fail closed as `invalid_client`, and concurrent
  rotations use versioned compare-and-swap.
- **fix(upgrade): no legacy-grant resurrection.** The stored-DCR migration
  invalidates pre-cutover authorization grants, and grant generations prevent a
  rollback/re-upgrade from reviving grants created by an older binary.
- **harden(deploy): single-writer SQLite cutover.** v0.20.x supports one hosted
  gateway replica. The upgrade and rollback both require a no-overlap `Recreate`
  rollout, private state ownership/modes, and authenticated reverse-proxy
  forwarding metadata.
- **contract:** the successful `output:"extract", debug:false`
  application-agent envelope is frozen. This feature is additive for headless
  clients, but the stateless-to-stored DCR switch is breaking for existing
  interactive clients: they must register once again after the upgrade.

Checks: `pnpm run check`, 813 unit tests, 60 integration tests, 86 frozen
acceptance tests, build, and smoke passed on the merged implementation. The
time-bounded production-audit disposition for two ineligible transitive patches
is recorded in `docs/dependency-ledger.md`.

## [0.11.4] — 2026-07-06

A small patch: CI reliability, OAuth-rejection UX, and an auth JSON-RPC error-code collision. One CONTRACT change to the auth-failed JSON-RPC error code (`-32001` → `-32003`, see below); happy-path behavior is unchanged.

- **test(dos): runner-relative REDOS-5 perf guard — no absolute-wall-clock flake (#124/#136).** The `extractHtml` full-pipeline REDOS-5 test asserted an ABSOLUTE 3000ms wall-clock budget — runner-dependent (CI hit 3004ms during the 0.11.3 release run, then re-ran green), derailing the release CI. Replaced with two runner-relative assertions measured on the same run: a LINEARITY ratio (wall-clock at 10× input < 40× the small-input time; linear ≲10, the REDOS-5 quadratic bug ≈100) and a generous CONSTANT-FACTOR ceiling (~10× the healthy time, catches a linear-but-pathological regression the ratio misses). Swept all six sibling timing tests in the file. Teeth-checked (a reconstructed quadratic scanner hits ratio 99.7× → caught) and 10× stable.
- **fix(auth): actionable OAuth-rejection UX for non-OAuth Streamable HTTP clients (#104/#137).** A client POSTing a JSON-RPC body to `/mcp` without the OAuth flow got an unhelpful `invalid_token: Bearer token is required` plus a bare `WWW-Authenticate: Bearer`. Now an RFC 6750 §3 Bearer challenge carrying `error` + `error_description` ONLY when credentials were presented-and-rejected (a Bearer token that failed verification → `invalid_token`, or a verified token that failed a scope check → `insufficient_scope`); a no-credentials request stays realm-only per §3. The actionable remedy (`/oauth/token`) reaches the client via both the `WWW-Authenticate` `error_description` and the JSON-RPC `message`, ASCII-sanitized for the header (Node rejects non-ASCII header bytes — `ERR_INVALID_CHAR`). README decision table added; the `-32001` code was intentionally left to #100.
- **fix(mcp): auth JSON-RPC code off the `-32001` SDK `RequestTimeout` collision (#100/#138) [CONTRACT].** `AUTH_JSONRPC_CODE` was `-32001`, which is `@modelcontextprotocol/sdk`'s `ErrorCode.RequestTimeout` — the SDK EMITS `-32001` from its own timeout/cancellation paths, so a captatum auth failure was indistinguishable from "retry the request" (an SDK-based client would retry a 401 forever). Moved to `-32003`, single-sourced with the `-32050` admission-overload code in a new `src/interfaces/jsonrpc-error-codes.ts`, and guarded by a self-defending test that imports the SDK `ErrorCode` enum and asserts neither captatum code collides. **The auth-failed JSON-RPC error `code` is now `-32003` (was `-32001`); the message and HTTP semantics are unchanged.** Any client that was (incorrectly) matching on `-32001` to detect auth failure was already treating it as a retryable timeout.

Checks: `pnpm run check` + 509 unit + 60 integration fixture tests green. All three PRs codex-reviewed (clean on the final commit of each); the auth fixes additionally passed an adversarial multi-lens workflow (#104 surfaced 2 test-coverage gaps + 1 RFC-6750 §3 conformance finding, all fixed; #100 surfaced 0).

## [0.11.3] — 2026-07-06

Provenance-correctness + sensitive-detector fixes — honest 4xx/5xx receipts (the headline) and a content-only loopback exemption made leak-safe. No breaking changes (one new `access.gateReason` value: `http_error`).

- **fix(receipt): honest 4xx/5xx handling — `http_error` gate.** A 4xx/5xx is an error page, not content. Previously a thin text/html error page (nginx 404, SSG error) escalated to `render-blocked` with a false `gateReason` (the live sibling of #92, which fixed `text/plain` not `text/html`), and a non-empty error body (`text/plain "Forbidden"`, JSON, rich HTML) was presented as a successful, public, non-gated fetch (`status:pass`, `gateReason:none`, `ok:true`). Now the Tier-1 extract forces `jsRequired:false` + `resolvedVia:"tier1-error"` + an `http_error` warning (body still returned); `classifyAccess` → `gateReason:"http_error"` + `gated:true`; `classifyStatus` → `fail`; the hosted transform is skipped on 4xx/5xx (the error body is returned raw, not summarized); a Tier-3 render returning 4xx keeps the Tier-1 http-error gate. Documented in `docs/contracts.md`.
- **fix(sensitive): content-only loopback exemption, made leak-safe.** A loopback URL (`localhost`/`127.x`/`[::1]`) *embedded in fetched content* (a README/docs setup example) is no longer flagged — it resolves to the reader's machine. The exemption is **content-only** (a loopback SOURCE url is still flagged — SSRF) and **plain-loopback-only**: it does not apply when the URL carries a credential anywhere — query key, fragment key (HTML-escaped `&amp;` normalized; hash-router `#/path?code=` parsed), userinfo (`user:pass@`), or OAuth `code`/`refresh_token`/`token`/`key`/`auth` on a loopback redirect. The `#44` ad-noise guard holds (non-loopback `?token=`/`?key=` stay unflagged). Bracketed IPv6 internal hosts (`[fd00::1]`, `[fe80::1]` incl. RFC6874 zone ids) are now scanned (host + userinfo + path with balanced `[]`/`()` delimiters). Helpers extracted to `sensitive-urls.ts`; documented in `docs/threat-model.md`.
- **fix(router): `noneReason` reports `unconfigured`** (not `sensitive_content_no_local_provider`) on a zero-candidate router, even when the sensitive gate fired.

Checks: `pnpm run check` + 497 unit + 50 integration fixture tests green. Adversarially reviewed across multiple workflow passes; ~22 codex findings, all real, all fixed + verified live.

## [0.11.2] — 2026-07-06

One transform correctness fix (the two refinements deferred from #130's codex review) + a vendor-neutral docs pass. No breaking changes.

- **fix(transform): truncation loop refinements (#131)** — two edge cases in the transform truncation loop. **P2-B:** for `output: extract`, a length-capped completion is incomplete JSON; `finalize()` ran before the truncation check and threw `extract_invalid_json`, failing the request instead of escalating. Now truncation is checked first — a truncated completion records `success` (a budget cap isn't a hard failure, must not demote), keeps the raw text as best, and escalates / surfaces an honest `transform_truncated`. **P2-A:** `MAX_TRANSFORM_ATTEMPTS` shared one counter between hard-fail candidate fallback and truncation escalation, so 5 hard-fails threw `transform_provider_failed` without reaching a healthy later candidate. Now hard-fail + truncation-next-candidate self-terminate via candidate exhaustion, and a separate `escalations` counter bounds only truncation-budget retry. Refactored six helpers into `router-helpers.ts` (no behavior change); 5 new tests; an adversarial 4-lens review found 0 defects.
- **docs:** made the repo vendor-neutral — removed the AWS/Fargate deploy refs (`scripts/deploy.sh`, the runbook section of `docs/deploy.md`, a stale handoff doc) so the public repo carries no infra specifics (#133/#127).

Checks: `pnpm run check` + 491 unit + 50 integration fixture tests green.

## [0.11.1] — 2026-07-05

The model-aware transform cap (which 0.11.2 then refines), a deep-content extraction fix, multi-arch release images, and the egress-wall docs.

- **feat(transform): model-aware output cap + truncation escalation (#125/#130)** — per-model max output tokens (deepseek 16K / qwen 65K, was a global 4K cap), default budget 8K, `finish_reason=length` detection, escalation bounded by remaining context + the caller's explicit budget, honest `transform_truncated` advisory. Fixes silent truncation on heavy docs.
- **fix(extract): raise EXTRACT_CHAR_BUDGET 1MB → 5MB (#121)** — deep-content pages (Jira REST articles) were beheaded at the 1MB extraction cap.
- **ci(release): build multi-arch (amd64+arm64) GHCR images (#123)** — `release.yml` builds both arches (QEMU for arm64) so the Mac mini (arm64) pulls a native image.
- **docs:** the datacenter-ASN egress wall + the residential-egress (Mac mini) deploy (#122).

Checks: `pnpm run check` + 486 unit + 50 integration fixture tests green.

## [0.11.0] — 2026-07-05

Two coverage fixes closing the remaining dev-docs gaps from the 0.9.0/0.10.0 diagnosis: POST-data SPAs that hydrate via a first-party POST (Notion, Jira) and React streaming-SSR pages whose article body lives in a hidden Suspense boundary (Anthropic docs). Both codex-reviewed across multiple rounds.

- **feat(tier3): forward first-party POST + PSL-aware first-party gate (#111)** — Notion (`POST /api/v3/syncRecordValues`) and Jira (`api.atlassian.com` flags + `developer.atlassian.com` cookie-integrator) hydrate via a first-party POST; Tier-3 aborted every non-GET so they returned `render_empty`. Now forwards authorized first-party POSTs through `FetcherPort` so they render. `PostInit` is a separate 3rd arg to `fetchGuarded` (FetcherOptions stays immutable GET-shaped — the route handler fires per-subresource, so shared mutable opts would leak method into the next GET). Redirect body-drop (any 3xx incl. 307/308 reverts to GET + no body); POST-only; header allowlist (Content-Type only — never Cookie/Auth/Origin/Referer/Content-Length); body cap + release-on-reject essential-pool accounting; per-render POST semaphore. The first-party gate is PSL-aware via `psl` (full PSL incl. private domains — `tldts` was rejected, it collapses `github.io` cross-tenant). CORS for same-registrable cross-origin POSTs (Jira): a synthesized permissive OPTIONS preflight + `Access-Control-Allow-Origin` on the POST response (captatum is its own controlled fetcher; the POST carries no credentials). New runtime dep `psl@1.15.0` (MIT, the first `src/domain` third-party import).
- **fix(extract): recognize React streaming-SSR boundaries as visible (#118)** — React 18+ streams a boundary's real content inside `<div hidden id="S:N">` + a `$RC("…","S:N")` completion call that removes `hidden` after hydration. The hidden-subtree stripper treated these as hidden config blobs and dropped them, so Anthropic/Next.js docs returned only cookie/consent text (a false-positive Tier-1 "success"). A boundary is now un-hidden only when a `$RC` call TARGETS its id (not `$RS`/`$RX`/`$RT`; not a document-global flag), threaded from the full page so a scoped fragment's missing `$RC` script doesn't under-detect; `display:none` classes/inline styles still win. Live: docs.anthropic.com 0 bytes (cookie-text-only) → 2901 bytes of the real article, no render needed.

Checks: `pnpm run check` + 478 unit + 50 integration fixture tests green.

## [0.10.0] — 2026-07-05

Closes three of the four reliability gaps the 0.9.0 cross-model benchmark + 5-agent failure diagnosis filed (#108–#111). Three extraction/render fixes, all backward-compatible; each codex-reviewed. (#111 — first-party POST forwarding for Notion-style SPAs — is designed and deferred to 0.11.0; it touches the SSRF-critical egress path and warrants its own focused PR.)

- **fix(extract): score `<article>`/`<main>` by visible-text length (#108)** — `selectMainContentHtml` returned the *first* `<article>` blindly; on card-grid hubs (MS-Learn) that was a 4-word tile while the real text sat in `<main>`. Now scores the first `<article>` vs the richest chrome-stripped `<main>` and picks the larger, with `<main>` winning only when substantially richer (≥1.5×). `<aside>`/`<nav>`/`<footer>` stripped before scoring so a chrome-heavy `<main>` (Anthropic/Mintlify global footer) can't win on bulk. CJK-safe (character length, not a word-count filter). Live: MS-Learn hub 43-char tile → 1263-char hub intro; Anthropic + Vitepress unchanged.
- **fix(render): raise essential byte budget, guard empty-render promotion, bump settle (#110)** — (1) essential render pool 1×→3× `maxBytes`: heavy client apps (Cursor docs) ship >5MB of JS and crashed into an error boundary at the 1× cap; Cursor docs went 85-char "Something went wrong" → 1580 chars of real content. (2) a render that still yields empty text is no longer promoted as a Tier-3 pass (`render_empty`). (3) post-load settle 3000→5000ms for slow-hydrating docs SPAs. Plus the codex follow-ups (PR #115): empty-render preserves structured-data-only renders; `networkidle` reserves `settleMinDwellMs` for body-stability on short-`timeoutMs` callers (and skips at cap 0 — Playwright `timeout:0` is no-timeout, a hang risk); removed an unreachable render-failure advisory (#114).
- **fix(shell-gate): scaffolding WebPage/WebSite JSON-LD with empty content must not satisfy the gate (#109)** — JetBrains/Writerside ship `WebPage` nodes with an empty `description` as routing metadata; those satisfied the shell-gate so the page stopped at Tier-1 and returned *empty* content. A node typed only as a scaffolding type (WebPage/WebSite/CollectionPage/BreadcrumbList/…) now counts only with a non-empty content property OR a content-bearing nested entity (`mainEntity`/`about`/…), depth-capped against cycles. Live: JetBrains `welcome.html` empty tier1-jsonld → renders 1330 chars.

Checks: `pnpm run check` + 444 unit + 50 integration fixture tests green.

## [0.9.0] — 2026-07-04

Closes the gap a cross-model benchmark (captatum vs a naive webfetch, 48+ dev pages) found: captatum was losing to a plain fetch on JS-rendered docs and on docs themes whose prose isn't in an `<article>`. Two fixes + a breaking receipt label.

- **feat(render): auto-render JS-shells on hosted + honest `js-required` label** (#105) — `allowRender` now defaults to `true`: on hosted, genuine JS-shell pages (Anthropic, DevDocs, AWS, Apple) render automatically instead of returning an empty shell. The shell-gate (`jsRequired`) is still the arbiter, so SSR/static pages (~80%, the Tier-1 path) never render. Local (no browser) honestly reports `render-unavailable`. `allowRender:false` remains an opt-out (MCP + a new CLI `--no-render` flag). **Breaking:** `access.gateReason:"login"` → `"js-required"` (captatum never detected login walls; "login" was the render-needed catch-all).
- **fix(extract): fall back to `<main>` for docs themes without `<article>`** (#103) — VitePress, GitBook, mdBook, Svelte, HashiCorp docs SSR prose into `<main>` (sidebar in a sibling `<aside>`); captatum now selects `<main>` after `<article>`, returning the docs content instead of nav chrome. `<main>` is a subset of `<body>`, so it never returns more chrome than before.
- **Benchmark:** captatum-0.8.0 vs naive webfetch across 48 dev pages — captatum-wins 44% (app-state/JSON-LD/meta extraction), tie-content 25%, tie-chrome 31% (now mostly closed by these two fixes).

Deferred: Cursor render→error-page false-positive (#106), Mintlify extraction noise, anti-bot walls (PyPI/npmjs.com), `AUTH_JSONRPC_CODE=-32001` collision (#100) + OAuth-non-client UX (#104).

Checks: `pnpm run check` + 426 unit + 50 integration fixture tests green.

## [0.8.0] — 2026-07-04

The model router becomes a **proactive, silent reliability layer**, and admission overload becomes a distinct **retryable** signal. Additive contract surface; no breaks.

- **feat(router): proactive sticky demotion + silent model fallback** (#82) — the EMA "bandit" was dead code (#48-C pinned `order`-primary after it demoted on every transient empty). Now revived as **sticky** per-model health: a model demotes one rank only on **sustained** hard failure (≥3 of the last 5 attempts, recovering after 2 consecutive successes), so transient empties and soft/garbage output do **not** demote (the #48-C jumpiness, fixed). A successful model fallback is now **silent** (`status:"pass"`, no warning) — the failed-primary list rides on `transform.fallbackFrom` (visible via `debug:true` and a new `transformFallbackFrom` audit field). An all-models-fail still surfaces honestly. `ModelScore` → `{ model, outcome }`; the old EMA/scoreFor/scoreTransform deleted.
- **fix(mcp): admission overload is a distinct retryable JSON-RPC error** (#84) — was a generic `InternalError`; now `code:-32050` (server-defined, collision-free vs the SDK enum + captatum's `-32001`) with `data:{retryable:true}`, so a client can back off and retry instead of guessing.
- **docs:** truncation-pointer note clarified (the full text is in `content[0].text`, the canonical MCP channel — not a server cap). #83 closed (its doc half shipped in 0.6.0).

Checks: `pnpm run check` + 424 unit + 50 integration fixture tests green.

## [0.7.0] — 2026-07-04

Receipt trustworthiness: four correctness fixes — three of them stop the provenance receipt from actively lying to the agent. Additive contract surface (new `contentType: "json"` + `resolvedVia: "tier1-json"`/`"tier1-text"`); no breaks.

- **fix(shell-gate): non-HTML short bodies are content, not empty SPA shells** (#92) — a legit plain 404 with a trivial `text/plain` body was reported as a login-gated SPA needing JS render (`contentType: "spa"`, `gateReason: "login"`, `tier: "render-blocked"`). The shell-gate now short-circuits non-HTML bodies (`text/plain`, markdown, JSON, XML, image) to `content-present` before any render escalation, and `extractHtml` returns non-HTML bodies verbatim (no HTML-stripping, whitespace-collapse, or trim).
- **fix(tier1): route non-HTML responses away from the HTML extractor** (#94) — JSON API responses (e.g. `registry.npmjs.org`) were HTML-extracted, fabricating image URLs (`registry.npmjs.org/%22…svg%22`) from JSON string values, mislabeled `contentType: "unknown"`, falsely `resolvedVia: "tier1-html"`. JSON now: raw body verbatim, no fabricated images/structured, `contentType: "json"`, `resolvedVia: "tier1-json"`; text/markdown get `"tier1-text"`. The MCP text formatter omits the provenance comment for all JSON bodies (`application/json` + `+json`) so raw stays parseable.
- **fix(extract): scope raw visible text to the main `<article>`** (#93) — repo/blog/docs pages returned flattened site chrome (GitHub's nav header) with zero README text. `extractVisibleText` now runs on the page's main `<article>` (the README on GitHub, the body on most blogs/docs); the page is pre-cleaned (hidden/script/template/comment stripped) so a hidden or inert article isn't selected. Falls back to the full body when there's no `<article>`.
- **fix(store): self-diagnosing error when the SQLite store dir is unwritable** (#85) — under the hosted image's `USER node` the default `./data/captatum.sqlite` path is root-owned; a cryptic `EACCES` boot crash is now an actionable message naming the resolved dir + the `CAPTATUM_SQLITE_PATH` fix (covers both can't-create and exists-but-unwritable).
- **test:** REDOS-2 ratio guard hardened for CI stability (absolute budget + looser ratio).

Checks: `pnpm run check` + 415 unit + 50 integration fixture tests green.

## [0.6.0] — 2026-07-04

Ships the Tier-1 extraction-fidelity + cerebralvalley render-settle work, the shell-gate fix for client-rendered SPAs, the extraction/transform/hosted-auth hardening bundle, and a ~50-pattern deterministic integration fixture suite (real Chromium) now run in CI. Additive + fixes; no public-contract breaks.

- **feat(mcp): output-choice rule of thumb in server instructions** (#79) — `CAPTATUM_SERVER_INSTRUCTIONS` (sent on `initialize`) now teaches the token-saving default: long-form text → `summary`, structured page → `raw` for the lean extracted fields, specific fields → `extract` with a `schema`. Additive; test-locked.
- **fix(extract): Tier-1 content fidelity** (#67) — `<meta charset>` prescan; expanded app-state harvest (`__PRELOADED_STATE__` / `__APOLLO_STATE__` / `__NUXT_DATA__` / any `application/json` script, proto-pollution-safe keying); CSS `display:none` suppression; CDATA stripping before `JSON.parse`; inline SVG `<text>` harvest.
- **fix(render): content-aware post-networkidle settle** (#68) — the cerebralvalley regression: polls `page.content().length` so `setTimeout`/hydration-injected content is captured instead of snapped too early (settleMs 3000 / minDwellMs 1500 / stableMs 400).
- **fix(render): byte-budget no longer aborts essential scripts/fetches** (#80).
- **fix(extract): trivial JSON-LD no longer satisfies the shell-gate** (#87, #81) — empty / context-only `ld+json` blocks (`[]`, `{}`, `{@context}`) no longer count as usable structured data, so client-rendered SPAs correctly route to Tier-3 render instead of returning empty.
- **fix(extract): named-entities normalization** (#71).
- **fix: address outstanding PR review comments** (#59, #61, #63, #64, #66) (#69).
- **harden(extract / transform / hosted-auth / store)** (#86) — linearized adversarial-markup scanners (DoS-bound; `</script` no longer matches `</scripture>`); default output-token cap; Ollama `local` flag derived from a loopback URL; **refuse a bearer credential over cleartext http to a non-loopback host**; Cloudflare Access `https` + absolute-URL boot gates + optional email allowlist; consent-JTI expiry validation; pooled-connection release on all transaction paths; refresh-token family retention; fixed-precision UTC timestamps; IPv4/IPv6-literal loopback check (closes a `127.attacker.example` bypass); form-feed tag-boundary parser fix; TiDB-safe refresh-token sweep. The cleartext-bearer / CF-Access-https / absolute-`OAUTH_ISSUER` items are fail-fast boot guards on previously insecure-or-late-crashing inputs — noted here, not a contract change.
- **test/ci: deterministic integration fixture suite** (#65–#78, #70) — ~50 extraction/render patterns against real Chromium, run as a CI job.
- **docs: README re-centered on the trustworthy, provenance-carrying read** (#88); `CLAUDE.md` + `package.json` description aligned; stale `v0.4.0` release-version refs in `SECURITY.md`, `README.md`, and `docs/contracts.md` updated to `v0.6.0`.

## [0.5.0] — 2026-07-02

- **feat(cli): one-shot CLI + installable agent skill** — `captatum <url>` fetches + prints + exits (kills the #1 DX cliff: the stdio server silently waiting on stdin). `captatum skill install --target claude|codex` writes a captatum agent skill (SKILL.md / AGENTS.md section) so one command gives the agent a first-class "captatum" skill that knows when/how to fetch. `captatum --help` shows usage. No args → stdio MCP server (unchanged). The bin routes based on argv.
- **refactor(mcp): shared local-deps** — `src/interfaces/mcp/local-deps.ts` extracted (fetcher/extractor/transformer/renderer/clock/audit), side-effect-free, used by both the stdio bridge + the CLI.

## [0.4.1] — 2026-07-02

- **fix(mcp): silence local stdio stderr on boot** — the local-binary stdio bridge wrote an `audit.auth` event + a "ready" line to stderr before answering the MCP `initialize` request. Some clients (notably Claude Code) treat any stderr during the handshake as a fatal server error and refuse to connect (`-32000 Failed to reconnect`). Stderr is now silent on a healthy boot (audit/ready gated behind `CAPTATUM_STDIO_DEBUG=1`); a genuine boot failure still reports to stderr. Local-binary only — the hosted HTTP gateway is unaffected.

## [0.4.0] — 2026-07-01

Ships the ATS list-all-jobs Tier-2 adapters + client-aware shaping to `npx` users, and fixes the release workflow (the GitHub Releases page entry) + stale release-version doc refs.

- **feat(tier2): ATS list-all-jobs adapters** (#42, #58) — a career-board URL on an ATS host (Greenhouse/Lever/Ashby) resolves to a bounded structured roster via the platform's public list API in one call (no HTML crawl, no browser). Coverage moat: a generic fetch of `jobs.lever.co/<site>` returns a JS shell; Captatum returns every role as clean JSON. Detection is URL-host (board roots + exact list-API endpoints); single-job, `?gh_jid=`, `?ashby_jid=`, explicit-port, + non-canonical API URLs fall through to Tier-1. Every egress routes through the rebinding-proof `FetcherPort`; tokens fail-closed sanitized; input capped before normalizing (DoS-safe); roster ≤500.
- **feat(mcp): client-aware shaping** (#45, #59) — config-driven output shaping per OAuth `client_id` (`CAPTATUM_CLIENT_PROFILES`). The `text-forward` profile surfaces a compact diagnostics block in `content[0].text` when `debug` is on — fixes "debug:true does nothing in Claude Code" (debug landed only in `structuredContent`, which Claude Code doesn't render). Default for unknown/local clients = today's shape (additive, backward-compatible).
- **ci(release): create the GitHub Releases page entry** — `release.yml` built images + published npm on every tag but never created the Releases page entry (only v0.2.0 had one); added a `release-entry` job (`gh release create --generate-notes`).
- **docs: refresh release-version references** — the README deploy example (`CAPTATUM_TAG`) and `SECURITY.md` "latest release" line were stale at vv0.2.2; now track the current release.

## [0.3.0] — 2026-07-01

First release shipping the post-0.2.2 safety, anti-bot, extraction, and default-output
work to `npx` users — the npm package was stale at 0.2.2 (the deployed Docker image
already carried these).

- **feat(mcp): provider-conditional output default** (#56) — `summary` when a transform
  provider is configured (e.g. the hosted server), `raw` otherwise (e.g. local with no
  `OPENROUTER_API_KEY`). Retires the local DX cliff where a zero-config `summary` silently
  degraded to a ~3000-char excerpt; a zero-config call now honestly returns full raw
  content. The OAuth scope gate resolves the effective output, so a zero-config `raw` call
  needs only `fetch:read`.
- **fix(extract): Pinterest pin caption** (#54 Half A, #55) — a pin's `SocialMediaPosting`
  JSON-LD `articleBody` (author, follower stats, source text) now surfaces on real pin
  detail pages (`pinterest.*/pin/<id>/`, `pin.it`), without ever letting an embedded social
  post dominate an article/landing/board page. Spoof-safe host allowlist + balanced JSON-LD
  traversal (handles `@graph`, array scripts, co-typed nodes, multi-posting selection).
- **feat(#41 Half A, #50): honest anti-bot detection** — Cloudflare/Akamai/PerimeterX
  challenge walls are detected (status-independent, vendor-specific body/header markers)
  and reported as gated (`gateReason: captcha`, `challengeProvider`) — captatum does NOT
  bypass them. Tool description de-overclaimed accordingly.
- **fix(llm): #48** (#53) — pinned `OPENROUTER_MODELS` order so `deepseek-v4-flash` stays
  primary; an empty completion now retries the fallback (with `fallbackFrom` + a warning)
  instead of demoting the primary.
- **fix(safety): sensitive-detector FP + adblocker** (#46, #47, #49) — public news pages
  no longer mis-flagged "sensitive" (tightened credential-query scan; dropped the
  path-segment slug heuristic; ad/tracker domain blocklist in Tier-3 + URL strip in
  Tier-1; closed an orphaned-credential-param bypass; source-URL JWT scan).
- **ops/docs:** `deploy.sh` reads the running browser-sidecar tag (no stale default);
  README/docs honest-scoped (coverage moat, HTTPS-fingerprint caveat).

## [0.2.2] — 2026-06-26

First **working** npm publish (`npx -y @edictum/captatum`). Compiled `src/` → `dist/`
for the published package (Node 24 refuses to type-strip `.ts` inside `node_modules`,
so 0.2.1's bin failed to start).

- `tsconfig.build.json` (`rewriteRelativeImportExtensions`); `pnpm run build` in the
  release job; `bin/captatum.mjs` runs the compiled bridge.
- npm **Trusted Publishing (OIDC)** — passwordless, provenance-attested, no `NPM_TOKEN`.
- Same engine as 0.2.0/0.2.1 (all the v0.2.x work below).

## [0.2.1] — 2026-06-26  ⚠️ broken (deprecated)

First npm publish via Trusted Publishing, but the bin pointed at the `.ts` entrypoint,
which Node 24 cannot type-strip inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
**Use 0.2.2+.** Fixed in 0.2.2 by shipping compiled `dist/`.

## [0.2.0] — 2026-06-26  (Docker/GHCR only; no npm)

Inaugural release. The v0.2.x arc:

- **fix(extract):** strip `display:none`/`hidden` DOM so hidden config blobs (vscdn/Netflix
  `themeOptions`) don't leak into `output:raw` or satisfy the shell-gate. New single-pass
  O(n) `hidden.ts`. `output:raw` leads with the content-bearing JSON-LD description.
- **feat(store):** SQLite (`node:sqlite`) is the default hosted OAuth-state store (no
  database required); TiDB optional via `TIDB_HOST`. Self-host templates (Railway/EC2/Mac Mini).
- **chore:** brand (Captatum mark + Capture Violet), README rewrite (features → why →
  quickstart → deploy → security → docs), LICENSE/CONTRIBUTING/CoC, CI + release workflows
  (GHCR publish on tag, SHA-pinned actions), minimized gateway Dockerfile (no Chromium —
  Tier-3 via the sidecar over CDP; `render-unavailable` when hosted has no sidecar).
- **feat(mcp):** self-describing — rich tool `description` + server `instructions` on
  `initialize`; both shapes share `createCaptatumMcpServer`. `docs/two-shapes.md` decision
  (keep both, hosted primary).
- **chore(release):** SHA-pin all CI/release actions; node 24.17.0 + playwright 1.61.0 pins
  (CVE-driven); README hardened (provenance rationale, honest HTTPS-fingerprint caveat,
  summary-needs-provider, `fetch:transform` scope warning, comparison table); SECURITY.md;
  scrubbed personal data from CLAUDE.md; purged all smart-fetch references; SQLite-default
  store-availability for deploy.

## [0.0.1] — 2026-06-26  (npm placeholder, deprecated)

One-time bootstrap publish to reserve `@edictum/captatum` and configure npm Trusted
Publishing. **Deprecated — use 0.2.2+.**
