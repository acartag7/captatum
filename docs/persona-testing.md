# Persona clean-room testing — reusable prompt

A reusable protocol for testing captatum's developer experience, docs, and product
direction from a **truly clean state**, through the eyes of multiple personas. Run it
before any release that changes the install path, README, or DX.

> The automated version lives in the repo as a Workflow script
> (`captatum-persona-cleanroom-test-*.js` under `.claude/workflows/`); this doc is the
> human-readable prompt you can hand to an agent or run manually.

## Goal

Answer four questions honestly, from cold installs (no captatum, no cache):

1. **Does it install + work?** (`npx -y captatum` reaches the ready line.)
2. **Is the README relevant + accurate** for each persona?
3. **Are the docs clear, not confusing?** Where does a new user stumble?
4. **What should we build / improve / extend next?**

## Clean environment

Each persona tests in a **fresh** environment with nothing pre-installed — simulating a
brand-new user. Two options:

- **limactl** (preferred — a real isolated VM):
  ```sh
  limactl start --name=captatum-clean --tty=false template://default
  # Lima's default guest is Ubuntu (no Homebrew) — install Node 24 via NodeSource:
  limactl exec captatum-clean -- sh -c 'command -v node || (curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt-get install -y nodejs)'
  # set -o pipefail so a failed `npx` (broken publish / native-module error) is not masked by `tail`:
  limactl exec captatum-clean -- sh -c 'set -o pipefail; npx -y captatum </dev/null 2>&1 | tail -6'
  ```
- **Docker** (lighter — a clean container, same install/DX signal):
  ```sh
  docker run --rm node:24 sh -c 'node -v && (set -o pipefail; npx -y captatum </dev/null 2>&1 | tail -6); echo EXIT=$?'
  ```

A `</dev/null` on stdin makes the stdio bridge start, print its ready line, and exit —
that proves the published package installs, the bin runs, Node 24 is satisfied, and the
native `wreq-js` prebuilts resolve, with no Chromium download (Tier-3 is lazy).

## Personas

Pick the set that covers the funnel (5 is a good default):

| Persona | Lens |
| --- | --- |
| **first-time developer** | Never used captatum. Get a successful first result in minutes. Where do you get stuck? |
| **MCP-client integrator** | Wire Claude Desktop / Cursor / Claude Code. Config snippet, scopes (`fetch:read` vs `fetch:transform`), provider requirement, local vs hosted. |
| **self-host / DevOps** | Deploy one replica for a team (docker-compose, secrets, Cloudflare, SQLite, browser sidecar). Reproducible? What's missing? |
| **security reviewer** | SSRF, browser sandbox, OAuth, prompt-injection, supply chain. Are the docs honest about limits? |
| **product strategist** | Adopt vs WebFetch/Firecrawl/Jina. Is the value prop sharp? What features/extensions/positioning make it a must-have? |

## Per-persona steps

For each persona, in its own clean env:

1. **Clean install** — run the limactl/docker one-liner above. Record: did it reach the
   ready line? Time to first result? Any errors, native-module issues, surprises?
2. **(Optional) a real fetch** — drive JSON-RPC over stdio (initialize → tools/call with a
   safe URL, `output: raw`) and confirm a provenance-bearing result. Confirms the engine,
   not just the boot.
3. **Read the docs** — README, `docs/contracts.md`, `docs/threat-model.md`,
   `docs/two-shapes.md`, `docs/dependency-ledger.md`, `deploy/README.md`, `SECURITY.md`.
4. **Evaluate** as the persona:
   - README relevance/accuracy (quote off-notes).
   - Doc clarity issues (confusing/missing/contradictory — quote the spot).
   - DX friction (where a real user stumbles).
   - Confusions a new user would hit.
5. **Propose** — `feature_suggestions`, `improvement_suggestions`, `extension_ideas`
   (adapters, integrations, ecosystems, governance tie-ins). Be concrete.

## Synthesize

Consolidate all personas into: prioritized DX/doc fixes (ranked, tagged), ranked new
feature ideas (value vs effort), ranked extension directions, release blockers, and a
one-paragraph honest DX verdict: *is captatum pleasant for a brand-new user today?*

## What good looks like

A passing run = every persona's clean install reaches the ready line on the first try
with zero native-module errors and zero Chromium download, AND the synthesis surfaces
fewer than ~2 release-blocking DX/doc defects. Anything more is pre-release debt.
