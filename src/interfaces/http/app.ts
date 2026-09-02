import Fastify, { type FastifyInstance } from "fastify";
import type { Bridge, BridgeConfig, IdentityPort, RateLimitPort, RequestAuthorizer } from "mcp-sso";
import { registerOAuthRoutes } from "mcp-sso/fastify";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { DeploymentFlavor } from "../../application/mcp-sso-config.ts";
import type { CaptatumUseCase } from "../../application/use-cases/captatum.ts";
import { config } from "../../config.ts";
import { registerMcpRoute } from "./mcp-route.ts";
import { sendHttpError } from "./errors.ts";
import { authenticateProxyHeaders } from "./proxy-auth.ts";
import type { CaptatumBulkMcpExecutor } from "../mcp/server.ts";

export interface HttpAppDeps {
  captatum: Pick<CaptatumUseCase, "execute" | "defaultOutput">;
  flavor: DeploymentFlavor;
  /** mcp-sso Bridge — owns the OAuth config + store; serves the `/oauth/*` +
   *  `.well-known/*` routes via `registerOAuthRoutes`. Its `config` is the hosted
   *  BridgeConfig (used for the `/mcp` 401 challenge). */
  bridge: Bridge;
  /** mcp-sso RequestAuthorizer — verifies the bearer token on `/mcp`. Hosted-only. */
  authorizer: RequestAuthorizer;
  /** Cloudflare-Access IdentityPort — resolves the `/oauth/authorize` subject from the
   *  `Cf-Access-Jwt-Assertion` header. Built once in the composition root (captatum's
   *  AUTH-1 boot gate guarantees CF Access is configured for the hosted flavor). */
  identity: IdentityPort;
  clock: ClockPort;
  audit: AuditLoggerPort;
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Socket peers allowed to supply the effective client address used by auth
   * rate limits. Forwarding headers from every other peer are ignored. */
  trustedProxyCidrs: string[];
  /** Edge-only 32-byte authenticator required before forwarding headers carry
   * authority, even when the socket peer is allowlisted. */
  proxyAuthSecret: string;
  /** Raw captatum_bulk use case; absent when CAPTATUM_BULK_ENABLED is off (hosted). */
  bulk?: CaptatumBulkMcpExecutor;
  /** The SAME limiter instance the Bridge was constructed with — REQUIRED, so OAuth
   * traffic is bounded by ONE shared map (contract: a single map capped at 4,096 keys;
   * a second instance would double the key budget and split accounting). Captatum also
   * uses it for the two OAuth POSTs the library adapter leaves unthrottled. */
  authRateLimit: Pick<RateLimitPort, "check">;
}

/**
 * Thrown when the HTTP MCP listener is asked to run under a non-hosted flavor.
 * The HTTP `/mcp` surface is the *hosted* (OAuth-authenticated) path; the
 * local-binary flavor has no auth boundary and must never be network-exposed.
 */
export class HostedFlavorError extends Error {
  readonly code = "hosted_flavor_required";
}

/**
 * Fail loudly *before* any network listener is built if the HTTP/OAuth surface is
 * pointed at the local-binary flavor. The HTTP `/mcp` listener authenticates
 * every call via OAuth; the local-binary flavor is single-user with no auth, so
 * serving it over a network listener would expose an unauthenticated `/mcp`.
 * Local mode runs over the stdio bridge
 * (`node --no-warnings src/interfaces/mcp/stdio-bridge.ts`) instead — never HTTP.
 */
export function assertHostedFlavor(flavor: DeploymentFlavor): void {
  if (flavor !== "hosted") {
    throw new HostedFlavorError(
      "HTTP MCP listener runs only under the hosted flavor; refusing to expose " +
        "the local-binary flavor (no OAuth boundary) on a network listener. " +
        "Run local mode over stdio with `node --no-warnings src/interfaces/mcp/stdio-bridge.ts`.",
    );
  }
}

/** Fastify `requestTimeout`. Bounds REQUEST-BODY receipt only (a slow client streaming a huge
 *  body) — NOT handler/tool time. The `/mcp` handler calls `reply.hijack()` for Streamable HTTP,
 *  which decouples Fastify's request timers; tool execution is bounded by its OWN per-tier
 *  `timeoutMs` (single-fetch) + the bulk `maxGlobalWallMs` wall, both enforced inside `execute()`
 *  via `AbortController`. So this is NOT a backstop for tool execution, and the #148 wall fix
 *  works through the in-`execute()` AbortController — not through this server option. A handler-
 *  level deadline wrapping the MCP transport itself is a documented future defense-in-depth. */
const REQUEST_TIMEOUT_MS = 90_000;

/** OAuth protocol bodies are tiny (a few KiB of form/JSON); the 5 MiB global limit
 * exists for /mcp tool payloads only. Pre-auth parsing cost on /oauth/* is bounded
 * by this cap (V4, 2026-09-01). */
const OAUTH_BODY_CAP_BYTES = 64 * 1024;

export async function createHttpApp(deps: HttpAppDeps): Promise<FastifyInstance> {
  assertHostedFlavor(deps.flavor);
  const oauthConfig: BridgeConfig = deps.bridge.config;
  const requestTimeout = REQUEST_TIMEOUT_MS;
  if (deps.trustedProxyCidrs.length === 0) {
    throw new Error("Hosted HTTP requires a non-empty trusted proxy allowlist");
  }
  if (deps.proxyAuthSecret.length !== 43) {
    throw new Error("Hosted HTTP requires a valid proxy authenticator");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: config.http.bodyLimitBytes,
    requestTimeout,
    trustProxy: deps.trustedProxyCidrs,
  });
  app.addHook("onRequest", async (request, reply) => {
    if (
      authenticateProxyHeaders(
        request.headers,
        request.raw.headersDistinct,
        request.raw.rawHeaders,
        deps.proxyAuthSecret,
      ) === "reject"
    ) {
      await reply.code(400).send({ error: "invalid_proxy_auth" });
      return;
    }
    // V4 (executed 2026-09-01, live on prod): Fastify parsed up to 5 MiB on the OAuth
    // POSTs BEFORE authorize()/guard() ran, and revoke/approve had no limiter. Both
    // checks run here — pre-parse, pre-auth, on the effective client address.
    if (request.method !== "POST") return;
    const path = request.raw.url?.split("?")[0] ?? "";
    const surface = path === "/oauth/revoke" ? "revoke:" : path === "/oauth/authorize/approve" ? "approve:" : undefined;
    if (surface) {
      const allowed = await deps.authRateLimit.check(surface + request.ip);
      if (!allowed) {
        await reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests — retry later" } });
        return;
      }
    }
    if (path.startsWith("/oauth/")) {
      const declared = Number(request.headers["content-length"] ?? "");
      if (Number.isFinite(declared) && declared > OAUTH_BODY_CAP_BYTES) {
        await reply.code(413).send({
          error: { code: "payload_too_large", message: `OAuth endpoint bodies are capped at ${OAUTH_BODY_CAP_BYTES} bytes` },
        });
      }
    }
  });
  // Chunked (Content-Length-less) OAuth bodies get the same cap per-route: Fastify's
  // own bodyLimit 413s them mid-stream instead of buffering up to the global 5 MiB.
  app.addHook("onRoute", (routeOptions) => {
    if (typeof routeOptions.url === "string" && routeOptions.url.startsWith("/oauth")) {
      routeOptions.bodyLimit = OAUTH_BODY_CAP_BYTES;
    }
  });
  app.setErrorHandler((error, _request, reply) => sendHttpError(reply, error, oauthConfig));
  app.get("/healthz", async () => ({ status: "ok" }));

  // OAuth 2.1 + metadata routes — served end-to-end by the mcp-sso Bridge via its
  // Fastify adapter. The identity (Cloudflare Access) is resolved from the
  // `Cf-Access-Jwt-Assertion` header (captatum's existing live-verified CF setup).
  await registerOAuthRoutes(app, {
    bridge: deps.bridge,
    identity: deps.identity,
    identityHeader: "cf-access-jwt-assertion",
  });

  await registerMcpRoute(app, {
    captatum: deps.captatum,
    authorizer: deps.authorizer,
    config: oauthConfig,
    audit: deps.audit,
    clock: deps.clock,
    hosted: deps.flavor === "hosted",
    allowedHosts: deps.allowedHosts,
    allowedOrigins: deps.allowedOrigins,
    ...(deps.bulk !== undefined ? { bulk: deps.bulk } : {}),
  });
  return app;
}
