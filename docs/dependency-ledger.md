# Dependency Ledger

Status: Broad dependency review last completed 2026-06-16. The changed
`mcp-sso@0.3.1` pin was rechecked 2026-07-28 against the npm registry, release
tag, signature, and SLSA provenance. Re-check every new or changed pin
immediately before any `pnpm install` / image build / deploy. All must clear
`minimumReleaseAge: 21600` (15 days) enforced in `pnpm-workspace.yaml`; run
`pnpm audit --prod` after install.

This ledger mirrors the table format of
`personal-memory-gateway/docs/dependency-ledger.md`. captatum is a networked
service (URL fetcher + headless render), so every direct runtime dependency is
justified here.

P10 reconciliation removed two previously direct dependencies that are not imported
by shipped code: `oauth4webapi` and `pino`. OAuth is implemented with `jose` plus
repo code; logging currently uses allow-listed console/stderr JSON records. `pino`
may still appear transitively through Fastify in the lockfile, but it is no longer
a direct dependency.

## Toolchain note: pnpm 10.32.0 via corepack

`packageManager` is pinned to `pnpm@10.32.0`. **pnpm 10.16.0 has a
`minimumReleaseAge` bug** (`ERR_PNPM_MISSING_TIME` — it fails to read the
packument `time` field for transitive deps like `jose`, even though the registry
provides it; verified 2026-06-15). 10.32.0 (also used by the sibling
`spec-reviewer` repo with the same 15-day gate) installs cleanly.

This machine's `pnpm` on `PATH` comes from fnm and is an older/buggy version, so
run pnpm through corepack, which honors the `packageManager` pin:

```bash
corepack prepare pnpm@10.32.0 --activate   # one-time
corepack pnpm install
corepack pnpm run check:syntax && corepack pnpm run check:lines && corepack pnpm run typecheck
```

(Note: `corepack pnpm run check` nests `pnpm run …` which can re-resolve to the
fnm binary; run the three sub-scripts directly as above.)

## Toolchain note: Bun for local-binary packaging (external tool, no npm pin)

The self-contained local binary is produced by `pnpm run build:binary`
(`scripts/build-binary.sh`) using `bun build … --compile`. **Bun is an external
developer tool, not an npm dependency** — no package was added to `package.json`
or the lockfile for packaging, so the 15-day `minimumReleaseAge` gate is not
engaged by this work. The stdio bridge itself runs under the pinned Node 24
toolchain via `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` (the
stdio-safe command; `pnpm run bridge` emits a pnpm banner on stdout and must not
be the client command — use `corepack pnpm --silent run bridge` if a package
script is required); Bun is required only to emit the single-file
artifact. When Bun is absent, the build script exits non-zero with the exact
command to run on a Bun-equipped machine and produces no artifact. If a future
change needs an npm package for packaging, it must be added here and clear the
15-day rule first.

## Direct dependencies, dev dependencies, and runtime pins

| Name | Proposed pin | Release/publish date | Date checked | Source URL | Reason |
| --- | --- | --- | --- | --- | --- |
| Node.js | `24.17.0` | `2026-06-17` | `2026-06-25` | https://nodejs.org/dist/index.json | Runtime target (`engines.node: ">=24"`); Node 24 native TS, no build step. Bumped 24.16.0 → 24.17.0 in the CVE rebuild (#27); 8 days old as of 2026-06-25 — under the 15-day gate (clears 2026-07-02), CVE-driven. The Docker image is digest-pinned. |
| pnpm | `10.32.0` | `2026-03-09T21:50:06.437Z` | `2026-06-15` | https://www.npmjs.com/package/pnpm/v/10.32.0 | Package manager; enforces 15-day `minimumReleaseAge`. 10.32.0 required (10.16.0 has the MISSING_TIME bug — see above). Run via corepack. |
| `@modelcontextprotocol/sdk` | `1.29.0` | `2026-03-30T16:50:42.718Z` | `2026-06-15` | https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.29.0 | MCP protocol server + Streamable HTTP transport for the hosted `/mcp` endpoint. |
| `fastify` | `5.8.5` | `2026-04-14T12:07:12.232Z` | `2026-06-15` | https://www.npmjs.com/package/fastify/v/5.8.5 | HTTP server + OAuth callback routing for the hosted flavor. |
| `jose` | `6.2.3` | `2026-04-27T15:23:35.019Z` | `2026-06-15` | https://www.npmjs.com/package/jose/v/6.2.3 | OAuth ES256 JWT sign/verify + JWKS for gateway-owned auth (hosted flavor only). |
| `mcp-sso` | `0.3.1` | `2026-07-28T03:03:04.162Z` | `2026-07-28` | https://www.npmjs.com/package/mcp-sso/v/0.3.1 | OAuth 2.1 / stored DCR / PKCE / Cloudflare-Access bridge plus the atomic machine-client lifecycle used by the operator CLI. Captatum dogfoods the owner's OSS library (acartag7/mcp-sso) rather than maintaining a divergent auth fork. Single runtime dependency `jose` is already pinned; optional database peers are not installed for the v0.20.0 SQLite-only release. **Fresh on 2026-07-28 and therefore under the 15-day gate; allowed only by the scoped `minimumReleaseAgeExclude` for the owner's own `mcp-sso` package. Registry evidence: SHA-512 integrity `sha512-bwDv9tYNtGl9fXSSWHWUxpWfMvkpdHjtPR/qA8XpqztC+aULkyeDwg0yqEmSLSiRUmO3D0Ijm5yoPc2l/wjRqQ==`, SHA-1 `f09d785047877297f60f032cb0c0c630f7215671`, npm registry signature, and SLSA provenance. The 200-file tarball contains the declared root export plus `dist/machine-client.js`, its declarations, the versioned client-store contract, and the SQLite adapter. Tag `v0.3.1` resolves to `0dacbd7d11471ee832fd836c1ab83efff9f307b9`.** |
| `wreq-js` | `2.3.1` | `2026-05-20T09:13:40.492Z` | `2026-06-15` | https://www.npmjs.com/package/wreq-js/v/2.3.1 | Tier-1 fetch: Rust-powered browser TLS/JA3+JA4 fingerprint impersonation for anti-bot bypass. The one hard ingredient; `fetch()`-compatible with native prebuilts, MIT. |
| `psl` | `1.15.0` | `2024-11-07T20:54:05Z` (latest available; no newer release) | `2026-07-05` | https://www.npmjs.com/package/psl/v/1.15.0 | Public Suffix List (registrable-domain) lookup for the #111 Tier-3 POST first-party gate (`src/domain/registrable-domain.ts`) + the future bulk feature's same-registrable scope. Bundles the FULL PSL incl. private domains (multi-tenant suffixes: `github.io`/`appspot.com`/`herokuapp.com`), which `tldts` (ICANN-only) omits — that omission would collapse cross-tenant hosts to one registrable domain (the SSRF bypass #111 exists to prevent). MIT; well past the 15-day gate. Data-freshness caveat: a multi-tenant suffix added upstream after this release is not yet recognized (bounded by per-hop SSRF + no forwarded credentials) — see `docs/threat-model.md` "PSL data lag". Reused by #111 + bulk, so one PSL source of truth. |
| `playwright` | `1.61.0` | `2026-06-15T10:06:22.269Z` | `2026-06-25` | https://www.npmjs.com/package/playwright/v/1.61.0 | Tier-3 render adapter, lazy `import("playwright")` only when `allowRender: true` and the shell-gate requires it. Bumped 1.60.0 → 1.61.0 in the CVE rebuild (#27) to patch a Chromium CVE; 10 days old as of 2026-06-25 — under the 15-day gate (clears 2026-06-30), CVE-driven exception. Browser sidecar bumped in lockstep. (Earlier `hono` audit noise was via `@modelcontextprotocol/sdk`; see P9 below.) |
| `zod` | `4.4.3` | `2026-05-04T07:06:40.819Z` | `2026-06-15` | https://www.npmjs.com/package/zod/v/4.4.3 | Tool I/O schemas (captatum params, extract schema, provenance). |
| `typescript` | `6.0.3` (exact pin) | `2026-04-16T23:38:27.905Z` | `2026-06-15` | https://www.npmjs.com/package/typescript/v/6.0.3 | Dev typecheck (`tsc --noEmit`). 6.0.3 required for `target: ES2023` + `allowImportingTsExtensions` (matches personal-memory-gateway / spec-reviewer). |
| `@types/node` | `24.12.4` (exact pin) | `2026-05-11T22:25:29.000Z` | `2026-06-15` | https://www.npmjs.com/package/@types/node/v/24.12.4 | Dev Node 24 typings. Pinned exact to avoid floating to `24.13.x` (published 2026-06-04/05/10, past the 15-day cutoff). |

## Gating check

The 15-day gate means a pin is eligible only if published on or before
`2026-06-01` when checked on `2026-06-16`. Pins published after that date must
wait.

Pass (eligible on `2026-06-16`, all published `<= 2026-06-01`):

- Node.js `24.16.0` (`2026-05-21`) — PASS
- pnpm `10.32.0` (`2026-03-09`) — PASS
- `@modelcontextprotocol/sdk@1.29.0` (`2026-03-30`) — PASS
- `fastify@5.8.5` (`2026-04-14`) — PASS
- `jose@6.2.3` (`2026-04-27`) — PASS
- `wreq-js@2.3.1` (`2026-05-20`) — PASS
- `playwright@1.60.0` (`2026-05-11`) — PASS
- `zod@4.4.3` (`2026-05-04`) — PASS
- `typescript@6.0.3` (`2026-04-16`) — PASS
- `@types/node@24.12.4` (`2026-05-11`) — PASS

CVE-driven exceptions (adopted in the #27 rebuild, rechecked `2026-06-25`):
`node@24.17.0` (`2026-06-17`, 8 days — clears the gate `2026-07-02`) and
`playwright@1.61.0` (`2026-06-15`, 10 days — clears `2026-06-30`) were bumped to
patch a Chromium/Node CVE ahead of the 15-day buffer; the Docker images are
digest-pinned and the npm tarball hash is frozen in the lockfile. Every other
selected pin clears the 15-day gate.

`typescript` and `@types/node` are **pinned exact** (not ranges) in
`package.json` to keep resolution deterministic under the 15-day gate.

## P9 install and audit result

Install command:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 COREPACK_HOME=/private/tmp/captatum-corepack \
  PNPM_HOME=/private/tmp/captatum-pnpm corepack pnpm add playwright@1.60.0 --save-exact
```

Result: install succeeded with `playwright@1.60.0`; browser binaries were not
downloaded during dependency install.

Audit command:

```bash
COREPACK_HOME=/private/tmp/captatum-corepack PNPM_HOME=/private/tmp/captatum-pnpm \
  corepack pnpm audit --prod
```

Result on `2026-06-16`: **failed** with 5 advisories against transitive
`hono@4.12.23` through `@modelcontextprotocol/sdk@1.29.0` (1 high, 4 moderate;
patched `hono >=4.12.25`). The patched `hono@4.12.25` was rechecked in the npm
registry and was published `2026-06-09T03:28:50.819Z`, so it did **not** clear
the 15-day rule on `2026-06-16`. The override was added on `2026-06-17` as a
deliberate one-time `minimumReleaseAge` exception to close the HIGH CORS +
4 moderate advisories (commit `24a3dd4`). As of `2026-06-24` the pin is 15 days
old and clears the gate normally — no exception is needed going forward.
This audit blocker is unrelated to the new `playwright@1.60.0` pin.

## Current package state

This ledger is the source of truth for which versions are allowed into the
lockfile. Do not add a new direct dependency or bump an existing pin without
rechecking it here against the registry and the 15-day rule, and resolving or
documenting any `pnpm audit --prod` finding.

## Browser sidecar image (Dockerfile.browser)

The Tier-3 sidecar runs Chromium in its own container; the gateway connects over
CDP (`CAPTATUM_BROWSER_CDP_ENDPOINT`). The sidecar image MUST ship a Chromium
whose major version matches the gateway's `playwright` pin above (`1.61.0` →
Chromium 149), or the CDP connection can break.

- Image: `mcr.microsoft.com/playwright:v1.61.0-noble` (matches the npm pin; reuse
  Microsoft's signed Playwright image rather than building Chromium from source).
- Re-check the image tag's publish date against the 15-day rule before pinning a
  newer one; record it here. `--no-sandbox` runs inside this container only
  (container-isolated) — never in-process with the gateway (see threat-model.md).

## Multi-arch GHCR images (release.yml)

Both images (gateway `Dockerfile` + sidecar `Dockerfile.browser`) build
**linux/amd64 + linux/arm64** so the arm64 Mac mini k3s deploy pulls
`ghcr.io/acartag7/captatum:latest` natively instead of building locally. arm64
is cross-built via QEMU (`docker/setup-qemu-action`) on the amd64 runner. Both
base images (`node:24.17.0-bookworm-slim`, `mcr.microsoft.com/playwright:v1.61.0-noble`)
are pinned by digest to **multi-arch manifest lists** (verified: both carry
linux/amd64 + linux/arm64), so `FROM` resolves arm64 without a digest change.

GitHub Actions used in `release.yml` (all pinned by commit SHA; recheck against
the 15-day rule before bumping):

- `docker/setup-qemu-action@06116385d9baf250c9f4dcb4858b16962ea869c3` — v4.1.0 (`2026-05-27`, 39d when pinned `2026-07-05`). QEMU binfmt for arm64 cross-build. **The binfmt image is also digest-pinned** (`image:` input) — the action's default is `tonistiigi/binfmt:latest` (mutable), which would run before the `packages:write` build; pinned to `tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0` (== `qemu-v10.2.3` tag, `2026-06-08`, 27d — past the gate).
