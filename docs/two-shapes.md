# Decision: two deployment shapes

**Decision: keep both shapes — shipped.** (Previously a recommendation awaiting
sign-off; confirmed 2026-06-26.) Hosted is primary; the local binary is retained.
Captatum ships two runtime shapes off one core engine; both are live.

## TL;DR

**Keep both. Hosted is primary; the local binary is the zero-friction developer /
privacy entry point.** They serve different audiences and share the entire core
engine, so the marginal maintenance cost is small and well-isolated.

## The two shapes

| | **Hosted remote server** (primary) | **Self-contained local binary** |
| --- | --- | --- |
| **Transport** | Streamable HTTP `POST /mcp` | stdio (`StdioServerTransport`) |
| **Auth** | OAuth gateway (PKCE, scopes, audit) | None — single-user, loopback only |
| **Reachable from** | Web agents (claude.ai, chatgpt.com), shared users | One local agent (Claude Code, desktop clients) |
| **Entrypoint** | `src/server.ts` → `createHttpApp` | `src/interfaces/mcp/stdio-bridge.ts` → `createLocalMcpServer` |
| **Tier-3 browser** | A separate browser Pod/network namespace over CDP, with default-deny direct egress | In-process Chromium on the user's machine (sandbox on) |
| **Core engine** | **Identical** — same `captatum` use case, tool schema, guarded fetch | **Identical** |

Both share `createCaptatumMcpServer`, so the tool definition, server instructions,
and provenance shape are the same in either shape (PR: MCP discoverability).

## Recommendation: keep both, hosted primary

### Why hosted is primary
Tier-3 rendering needs a real browser, which needs a real deployment (a separate
network namespace, enforced egress containment, lifecycle, isolation). The hosted shape is the only one that serves web
agents and multiple users — the production use case. Self-host templates
(Railway/EC2/Mac Mini) and the release pipeline target it.

### Why keep the local binary (its value, justified)
1. **Zero-friction developer entry.** The README quick start is `node … stdio-bridge.ts`.
   Dropping the local binary would force every developer to stand up OAuth signing
   keys + Cloudflare Access + a tunnel just to try Captatum — a large barrier to
   first run. The local binary runs in seconds with no secrets and no network
   listener.
2. **Privacy.** With a local Ollama transform, the local binary fetches and
   summarizes with **zero cloud egress** — attractive for sensitive/internal URLs
   that should never leave the machine. The hosted shape egresses to OpenRouter by
   default.
3. **Cheap to keep.** Both shapes already share the entire core engine; the local
   surface is the thin stdio bridge + `createLocalMcpServer`, and the security
   gating that keeps the two flavors from being cross-wired
   (`assertLocalFlavor` / `assertHostedFlavor`) already exists and is tested. There
   is no second codebase to maintain.
4. **Different audiences, not redundancy.** Hosted = production / web agents /
   multi-tenant. Local = development / single-user / private. Neither subsumes the
   other.

### The "Tier-3 needs a browser either way" point — addressed
It is true that JS rendering needs Chromium in *both* shapes, so "local" is not
lighter than hosted for JS-heavy pages. But the two use the browser differently:
the hosted shape isolates it in a separate browser workload (required for multi-tenant safety), while
the local shape uses the developer's own Chromium in-process (acceptable for a
single trusted user). They are not redundant; the browser requirement does not
argue for dropping the local shape.

### When to reconsider
Drop the local binary only if (a) the stdio bridge / local-server grows a divergent
feature set that doubles maintenance, or (b) a security review finds the
no-auth-loopback surface can't be kept safely loopback-bound. Neither is true today.

## How to choose (for users)

- **Trying Captatum / local agent / private URLs** → local binary
  (`node --no-warnings src/interfaces/mcp/stdio-bridge.ts`).
- **Production, web agents (claude.ai/chatgpt.com), multiple users** → hosted
  server (see [`deploy/README.md`](../deploy/README.md)).
