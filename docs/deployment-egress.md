# Deployment egress — the datacenter-ASN wall

> **TL;DR — captatum's *code* is egress-agnostic, but captatum's *deployment* is not.
> A hosted deployment on a cloud datacenter IP (AWS/GCP/Azure) loses to a plain
> residential webfetch on a specific, important class of sites — Cloudflare/anti-bot-
> protected pages (Notion, cppreference, npmjs, Cursor) — because those sites
> challenge or slow **datacenter ASNs**. captatum cannot bypass this in code (its TLS
> fingerprint is HTTP-only; HTTPS uses a checked-IP path with no fingerprint). The fix
> is a **deployment** choice: run captatum on a **residential-IP host** (an always-on
> Mac mini / home server) and expose it through a Cloudflare Tunnel. The code is
> unchanged; the residential egress is not challenged.**

This is one of the most important findings from the 0.11 retest matrix. It is recorded
here so future work does not chase code fixes for what is fundamentally a deployment-
egress problem.

## The finding

A hosted captatum on **AWS Fargate** (the original prod) egresses through an **AWS
datacenter ASN**. A meaningful set of sites detect datacenter egress at the TLS/HTTP
layer — before any page content is served — and respond with a challenge, an interstitial,
or a degraded/slow path:

| Site | Failure on AWS egress | Mechanism |
| --- | --- | --- |
| **Notion** (`*.notion.site`) | `render_empty` / `js-required` — the page's hydration resources are challenged/slowed from AWS, so the client app throws an error boundary instead of hydrating | Cloudflare + Notion's own edge; datacenter-ASN detection |
| **cppreference** | honest Cloudflare `captcha` (`gateReason: captcha`) | Cloudflare managed challenge on datacenter IPs |
| **npmjs** (`npmjs.com`) | Cloudflare `captcha` | Cloudflare managed challenge on datacenter IPs |
| **Cursor docs** (`docs.cursor.com`) | false-positive "Something went wrong" — a first-party resource the Mintlify/Next.js client awaits fails under the HTTPS checked-IP path from AWS | CDN/WAF challenging AWS egress |

A **plain webfetch from a residential IP** succeeds on these same sites — not because
its fetcher is better, but because **its egress IP is residential** and is not
challenged. captatum *on a residential IP* succeeds too (proven — see Evidence).

## Why captatum cannot fix this in code

- captatum's anti-bot TLS/JA3+JA4 fingerprint (`wreq-js`) is **HTTP-only**. HTTPS
  uses a checked-IP Node path with **no fingerprint** (a documented security-required
  limitation — see `docs/contracts.md`). So captatum cannot impersonate a browser's TLS
  handshake over HTTPS to pass a Cloudflare challenge.
- Even if it could, the **datacenter-ASN wall is upstream of the fingerprint**: the
  challenge is triggered by the egress IP's ASN reputation before the handshake
  completes. The #41 research (6-agent evasion study) concluded decisively that
  commercial "bypassers" work almost entirely because they route through **paid
  residential/mobile IP pools** — not because of any browser-layer trick. AWS offers no
  residential egress.
- Therefore no captatum code change (fingerprint, stealth, header) will close this gap
  on a datacenter deployment. The lever is the **egress IP**, which is a deployment
  property.

## Evidence

- **Notion renders correctly from a residential IP**: the exact
  `planetarium.notion.site/Nine-Chronicles-GraphQL-API-Guide-…` page that returns
  `render_empty` on the AWS-hosted connector returns **5982 chars of real article
  content at Tier-3** when captatum runs locally (residential IP), with the **same
  Chromium 149** the prod sidecar uses (`a953bb3`). The code path is identical; only
  the egress differs.
- **cppreference / npmjs** return `gateReason: captcha` from AWS; a residential curl
  gets `200`.
- The **0.11 retest matrix** (53 URLs): captatum-on-AWS loses to residential-webfetch
  precisely on the Cloudflare/anti-bot set (Notion, cppreference, npmjs, Cursor) and
  **nowhere else** — confirming the egress IP, not the fetcher, is the differentiator.

## The solution: a residential-IP host + Cloudflare Tunnel

Run captatum on an **always-on host with a residential ISP IP** (e.g. a Mac mini) and
expose it through a **Cloudflare Tunnel** (the inbound path is unchanged; only the
**outbound** egress moves to residential). The Cloudflare Tunnel carries *inbound*
traffic (claude.ai/ChatGPT → captatum); it does **not** proxy captatum's *outbound*
fetches — those egress directly from the residential host, which is the whole point.

- **No code change.** captatum's hosted flavor (HTTP server + OAuth) runs unchanged.
- **No new SSRF surface.** The `FetcherPort` rebinding-proof guard still pins every
  outbound connection; only the source IP changes.
- **No paid proxy.** The residential IP is the host's own ISP — free.
- **The browser workload** runs on the same physical host but in a separate
  Pod/network namespace. It has no direct page egress: its OUTPUT firewall permits
  only loopback and established replies, while every page request is fulfilled
  through the gateway's guarded fetcher. The guarded request therefore still
  egresses through the residential host.

See **[`deploy/mac-mini.md`](../deploy/mac-mini.md)** for the gateway-only Docker +
`cloudflared` + Cloudflare Access path. The production Tier-3 topology is the
isolated Kubernetes browser workload described in `docs/deploy.md`.

### Verification before cutover

Confirm the host's IP is clean (not a challenged/CGNAT/business IP):

```sh
curl -sI https://www.npmjs.com/package/react        # expect 200, not a challenge
curl -sI https://en.cppreference.com/w/cpp/algorithm/ranges/sort
curl -sI https://qogita.notion.site/               # any notion.site page
```

If any returns a Cloudflare challenge (`403`/`503` + challenge body), the IP is flagged
and the residential-host benefit won't apply (some ISPs use CGNAT or business ranges).
A typical home ISP IP passes.

## Trade-offs vs the AWS deployment

| | AWS Fargate (datacenter) | Residential host (Mac mini) |
| --- | --- | --- |
| **Egress IP** | datacenter ASN — challenged by CF/anti-bot sites | residential — not challenged |
| **Availability** | HA, multi-AZ, self-healing | single-point (one host; power/ISP outages) |
| **Cost** | pay-per-use | free (host you own) |
| **Ops** | managed (ECS, auto-restart) | you keep it on + restart on failure |
| **SSRF/security posture** | `FetcherPort` guard; Tier-3 needs an isolated browser workload | same guard; production Tier-3 adds a separate browser namespace and default-deny OUTPUT firewall |
| **Coverage** | loses Notion/cppreference/npmjs/Cursor | wins them |

For a personal / low-traffic product, the residential host's coverage win outweighs the
HA loss — especially with the AWS stack kept as a cold fallback (or decommissioned once
the residential deploy is stable). The Cloudflare Tunnel + Access front-door is identical
either way, so the **inbound** trust boundary (OAuth, CF Access on `/oauth/authorize*`)
does not change.

## What this does NOT change

- **Tier-1/2/3 code, the SSRF guard, the shell-gate, POST forwarding (#111), the React
  streaming-SSR fix (#118), the extraction budget** — all unchanged. The residential
  deploy is purely an egress change.
- **Sites that are *genuinely* gated** (paywalled, login-walled) are still gated — a
  residential IP doesn't bypass auth. The wall this doc addresses is the **datacenter-ASN
  challenge**, not access control.
- **The `FetcherPort` SSRF guarantees hold** — residential egress still routes through
  the rebinding-proof guard; private IPs are still blocked.

## Reference

- `deploy/mac-mini.md` — the residential-host deploy guide.
- `deploy/docker-compose.yml` — gateway + SQLite (the generic Tier-3-disabled base).
- `docs/threat-model.md` — "Deployment egress" (this finding in the threat model).
- Issue #41 Half B — the 6-agent evasion study that established the datacenter-ASN wall
  (browser-layer bypass is not viable; the IP is the lever).
