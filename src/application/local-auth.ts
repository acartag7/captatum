// LocalBypassAuthorizer — the local-binary stdio bridge's authorizer. The local
// flavor is single-user/single-agent over stdio with NO network listener and NO OAuth
// token. mcp-sso's `RequestAuthorizer` has an explicit no-bypass policy (it always
// verifies a bearer token), so the stdio bridge uses this tiny authorizer instead: it
// returns a fixed local subject carrying the full captatum scope catalog.
//
// STRUCTURAL ISOLATION (the load-bearing invariant): this authorizer is reachable ONLY
// from the stdio bridge (`src/interfaces/mcp/stdio-bridge.ts` → `local-server.ts`).
// The hosted HTTP `/mcp` path uses mcp-sso's `RequestAuthorizer`. `assertLocalFlavor`
// rejects a hosted runtime before this is constructed, and the stdio bridge opens no
// network listener — so it is structurally impossible to wire the bypass into the
// hosted HTTP path. It is not "conventionally" local-only; it cannot reach `/mcp`.
import type { AuthorizedSubject } from "mcp-sso";
import type { ClockPort } from "./ports/clock.ts";
import type { AuditLoggerPort } from "./ports/audit.ts";

const LOCAL_SUBJECT: AuthorizedSubject = Object.freeze({
  subject: "local-user",
  clientId: "local-binary",
  scopes: ["fetch:read", "fetch:transform"],
  credentialKind: "interactive",
});

/** The `.authorize()` shape the local stdio bridge calls (structurally compatible with
 *  mcp-sso's `RequestAuthorizer.authorize`, so the shared MCP server takes either). */
export interface LocalBypassAuthorizer {
  authorize(input: { authorization?: string | string[]; requiredScope?: string }): Promise<AuthorizedSubject>;
}

/** Build the local-binary bypass authorizer. It audits an `auth.request` success
 *  (subject `local-user`) on every call so the local flavor still produces an audit
 *  trail, then returns the full-scope local subject. `requiredScope` is accepted but
 *  not enforced — the local subject holds the whole catalog. */
export function createLocalBypassAuthorizer(clock: ClockPort, audit: AuditLoggerPort): LocalBypassAuthorizer {
  return {
    async authorize(_input: { authorization?: string | string[]; requiredScope?: string }): Promise<AuthorizedSubject> {
      await audit.writeAuthEvent({
        occurredAt: new Date(clock.nowMs()).toISOString(),
        event: "auth.request",
        status: "success",
        clientId: LOCAL_SUBJECT.clientId,
        subject: LOCAL_SUBJECT.subject,
        scopes: LOCAL_SUBJECT.scopes,
        reason: "local-bypass",
      });
      return LOCAL_SUBJECT;
    },
  };
}
