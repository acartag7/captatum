# Security Policy

Captatum is a URL-fetcher that may also run a headless browser — a textbook SSRF
and sandbox surface. Security is a first-class concern, not an afterthought.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via GitHub's built-in channel: **Security tab →
"Report a vulnerability"** (private vulnerability reporting). This notifies the
maintainers confidentially and lets us coordinate a fix and disclosure.

If GitHub private reporting is unavailable, open a plain issue asking a maintainer
to contact you privately — do **not** include vulnerability details in the public
issue.

Please include, where possible: a description, steps to reproduce, affected
component (egress/Tier-1 fetch, Tier-3 browser sandbox, OAuth, prompt-injection
handling, supply chain), and impact. We aim to acknowledge reports within a few
days.

## Supported versions

Only the **latest release** line receives security fixes — currently **v0.20.2**. Earlier 0.20.x patches do not carry the latest security fixes (0.20.2 added the popup-egress, credential-URL, WHATWG-backslash, and schema-ReDoS fixes over 0.20.0/0.20.1); upgrade to the newest patch rather than staying on an older v0.20.
Pin to a released tag; `main` is unreleased and may change.

## Threat model (authoritative)

[`docs/threat-model.md`](./docs/threat-model.md) is the security reasoning and the
list of required controls; [`docs/contracts.md`](./docs/contracts.md) §"Security
controls" is the contract reference. Key invariants:

- **SSRF:** every outbound request — Tier-1, Tier-2, every redirect hop, every
  Tier-3 browser subresource — routes through one rebinding-proof `guardedFetch`
  (resolve-once → pin-to-IP → revalidate each hop; exhaustive IANA private-IP
  blocking).
- **Tier-3 browser:** runs in a separate sidecar container (hosted); every browser
  request is fulfilled through `guardedFetch` (`route.fulfill`, never
  `route.continue`), so the browser makes no direct egress.
- **Auth:** the hosted flavor authenticates every `/mcp` request via gateway OAuth
  (PKCE S256, hash-only token storage, replay-revoking refresh rotation,
  per-request scope enforcement).
- **Prompt injection:** fetched content is treated as **untrusted data, never
  instructions**.

## Important scope limits

- The **local-binary flavor has no authentication** and must **never be exposed on
  a network** — it is single-user/single-agent, loopback only.
- Tier-1 HTTPS intentionally does **not** use the TLS fingerprint (it uses a
  checked-IP Node path to preserve rebinding-proof SSRF).
- Prompt-injection fencing applies to `summary`/`extract`, **not** `output: raw`.
- ~~One disclosed residual: a char-class/metachar ReDoS in extract-schema
  validation~~ **Retired in 0.20.2**: pattern EXECUTION is now wall-clock-bounded
  on a worker thread and fails closed on timeout, and pattern CONTENT is rejected
  at the input boundary before any fetch/LLM spend (the input-boundary heuristic
  remains shape-based, so a heuristic-passing pattern can still burn worker time —
  bounded, not unbounded).

## Supply chain

Dependencies are pinned, open-source, minimal, and held to a 15-day
minimum-release-age gate; `pnpm audit --prod` is required clean before any hosted
deployment (see [`docs/dependency-ledger.md`](./docs/dependency-ledger.md)). The
browser-sidecar base image is pinned by sha256 digest, and CI/release GitHub
Actions are pinned by commit SHA.
