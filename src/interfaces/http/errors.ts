import type { FastifyReply } from "fastify";
import { OAuthError, buildUnauthorizedChallenge, type BridgeConfig } from "mcp-sso";
import { AUTH_JSONRPC_CODE } from "../jsonrpc-error-codes.ts";

/** General Fastify error handler (non-OAuth-route errors; the mcp-sso `Bridge` catches
 *  its own OAuth-route errors and never throws here). An `OAuthError` reaching this is
 *  unexpected defense-in-depth — it still gets an RFC 9728 challenge on 401. */
export function sendHttpError(reply: FastifyReply, error: unknown, config: BridgeConfig): void {
  const oauthError = error instanceof OAuthError ? error : undefined;
  const framework = oauthError ? undefined : frameworkBodyError(error);
  const status = oauthError?.status ?? framework?.status ?? 500;
  if (status === 401 && oauthError) reply.header("www-authenticate", buildChallenge(config, oauthError));
  reply.code(status).send(
    oauthError
      ? { error: { code: oauthError.code, message: oauthError.message } }
      : framework
        ? { error: { code: framework.code, message: framework.message } }
        : { error: { code: "internal_error", message: "Request failed" } },
  );
}

/**
 * Fastify's request-body errors carry their real 4xx in `statusCode` — collapsing them
 * to 500 misreports client malformedness as server failure (executed 2026-09-01: an
 * UNAUTHENTICATED malformed-JSON POST /mcp got 500 internal_error, live on production
 * through the Cloudflare front). Map exactly the body-parsing family; anything else
 * stays 500 (unknown errors never leak internals).
 */
function frameworkBodyError(error: unknown): { status: number; code: string; message: string } | undefined {
  const e = error as { statusCode?: unknown; code?: unknown };
  // ONLY the request-body family remaps: an FST_ERR_CTP_* body error, or the raw V8
  // SyntaxError Fastify attaches statusCode 400 to for invalid JSON. Other 400s
  // (FST_ERR_BAD_URL, deliberately-thrown route errors) are NOT body errors and keep
  // the generic 500 handling (codex round: status-only matching mislabeled them).
  if (typeof e?.statusCode !== "number") return undefined;
  const code = typeof e.code === "string" ? e.code : "";
  if (e.statusCode === 400) {
    const isBodyParse = code === "FST_ERR_CTP_INVALID_JSON_BODY"
      || code === "FST_ERR_CTP_INVALID_JSON"
      || code === "FST_ERR_CTP_EMPTY_JSON_BODY"
      || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH"
      || (error instanceof SyntaxError && code === "");
    return isBodyParse
      ? { status: 400, code: "invalid_json", message: "Request body is not valid JSON" }
      : undefined;
  }
  if (e.statusCode === 413 && code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return { status: 413, code: "payload_too_large", message: "Request body exceeds the size limit" };
  }
  if (e.statusCode === 415 && (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_EMPTY_BODY")) {
    return { status: 415, code: "unsupported_media_type", message: "Unsupported content type for this endpoint" };
  }
  return undefined;
}

/** `/mcp` auth-failure handler: an RFC 6750/9728 `WWW-Authenticate` challenge on 401 +
 *  the captatum JSON-RPC auth-error body (`-32003`). The challenge is built by mcp-sso's
 *  `buildUnauthorizedChallenge` (RFC 9728 `resource_metadata` + the scope catalog + the
 *  OAuth error). */
export function sendMcpAuthError(reply: FastifyReply, error: unknown, config: BridgeConfig): void {
  const oauthError = error instanceof OAuthError
    ? error
    : new OAuthError(
      "invalid_token",
      "OAuth Bearer access token is invalid or expired — re-authenticate via /oauth/token",
      401,
    );
  if (oauthError.status === 401) reply.header("www-authenticate", buildChallenge(config, oauthError));
  reply.code(oauthError.status).send({
    jsonrpc: "2.0",
    error: { code: AUTH_JSONRPC_CODE, message: `${oauthError.code}: ${oauthError.message}` },
    id: null,
  });
}

function buildChallenge(config: BridgeConfig, error: OAuthError): string {
  return buildUnauthorizedChallenge(config, {
    scope: config.scopeCatalog,
    error: error.code,
    errorDescription: error.message,
  });
}
