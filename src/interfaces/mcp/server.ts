import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { CaptatumContext } from "../../application/ports/captatum-context.ts";
import { OAuthError, requireScope, type AuthorizedSubject } from "mcp-sso";
import { requiredScopeForCaptatum } from "../../application/scopes.ts";
import type { CaptatumUseCase } from "../../application/use-cases/captatum.ts";
import {
  DEFAULT_CAPTATUM_DEFAULTS,
  normalizeCaptatumInput,
  CaptatumInputError,
} from "../../application/use-cases/captatum-input.ts";
import type { Result } from "../../domain/result.ts";
import type { BulkResult } from "../../domain/bulk-result.ts";
import { resultToMcpText } from "./format.ts";
import { buildStructuredContent } from "./shape.ts";
import { isApplicationAgentProfile } from "./application-agent-profile.ts";
import { CAPTATUM_SERVER_INSTRUCTIONS, CAPTATUM_TOOL_NAME, captatumToolDefinition } from "./schema.ts";
import { CAPTATUM_BULK_TOOL_NAME, captatumBulkToolDefinition } from "./bulk-schema.ts";
import { callBulk } from "./bulk-handler.ts";
import { BulkQuotaError } from "../../application/ports/bulk-quota.ts";
import { config } from "../../config.ts";
import { parseClientProfileMap, resolveClientProfile, type ClientProfile } from "../../application/client-profile.ts";
import { AUTH_JSONRPC_CODE, OVERLOADED_JSONRPC_CODE } from "../jsonrpc-error-codes.ts";

/**
 * Thrown when the process-wide admission limiter is at capacity (DOS-2). `toMcpError` surfaces it
 * as a distinct RETRYABLE JSON-RPC error (OVERLOADED_JSONRPC_CODE + `data.retryable`) so a client
 * can back off and retry — instead of the generic InternalError it used to collapse to. The local
 * stdio bridge (single-user, no admission cap) never throws this. (#84)
 */
export class OverloadedError extends Error {
  /** Stable marker a caller/test can assert without parsing the message. */
  readonly retryable = true as const;
  constructor(message = "captatum: server overloaded") {
    super(message);
    this.name = "OverloadedError";
  }
}

/** The captatum_bulk executor shape (the bulk use case, admission-wrapped on hosted). */
export interface CaptatumBulkMcpExecutor {
  execute(input: unknown, context?: CaptatumContext): Promise<BulkResult>;
}

export interface CaptatumMcpServerDeps {
  captatum: Pick<CaptatumUseCase, "execute" | "defaultOutput">;
  auth: AuthorizedSubject;
  audit: AuditLoggerPort;
  clock: ClockPort;
  /** Present when captatum_bulk is enabled (local always; hosted only when CAPTATUM_BULK_ENABLED). */
  bulk?: CaptatumBulkMcpExecutor;
}

export function createCaptatumMcpServer(deps: CaptatumMcpServerDeps): Server {
  // #45: resolve the client-aware output profile once per server. The hosted path builds a server
  // per authorized request, so this is effectively per-request; unknown/local clientId → default.
  const profile = resolveClientProfile(deps.auth.clientId, parseClientProfileMap(config.mcp.clientProfiles()));
  const server = new Server({ name: "captatum", version: "0.2.0" }, {
    capabilities: { tools: { listChanged: false } },
    instructions: CAPTATUM_SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: deps.bulk ? [captatumToolDefinition, captatumBulkToolDefinition] : [captatumToolDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    if (name === CAPTATUM_TOOL_NAME) return await callCaptatum(request.params.arguments, deps, profile);
    if (name === CAPTATUM_BULK_TOOL_NAME) {
      if (!deps.bulk) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} is not enabled on this server`);
      return await callBulk(request.params.arguments, deps);
    }
    throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
  });

  return server;
}

async function callCaptatum(args: unknown, deps: CaptatumMcpServerDeps, profile: ClientProfile): Promise<CallToolResult> {
  const started = deps.clock.nowMs();
  try {
    const normalized = normalizeCaptatumInput(args, { ...DEFAULT_CAPTATUM_DEFAULTS, defaultOutput: deps.captatum.defaultOutput });
    requireScope(deps.auth, requiredScopeForCaptatum({ output: normalized.requestedOutput, transform: normalized.transform }));
    const result = await deps.captatum.execute(args, { fetchedAt: new Date(deps.clock.nowMs()).toISOString() });
    // AUDIT-1: audit write in its own try/catch — a rejecting sink must never
    // convert a successful fetch into a client error.
    try {
      await auditResult(deps, result);
    } catch (auditError) {
      process.stderr.write(`captatum: audit write failed: ${auditError instanceof Error ? auditError.message : auditError}\n`);
    }
    return {
      content: [{
        type: "text",
        text: resultToMcpText(
          result,
          profile.textDebug && normalized.debug,
          isApplicationAgentProfile(result, normalized.debug),
        ),
      }],
      structuredContent: buildStructuredContent(result, normalized.debug),
    };
  } catch (error) {
    await auditFailure(deps, args, started, error);
    throw toMcpError(error);
  }
}

export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof OverloadedError) {
    return new McpError(OVERLOADED_JSONRPC_CODE, error.message, { retryable: true });
  }
  if (error instanceof BulkQuotaError) {
    // exceeded → retryable (the client backs off + retries, like OverloadedError);
    // store_error → fail-closed refusal (non-retryable InternalError). The code
    // string rides on the message so the receipt distinguishes the two.
    if (error.code === "bulk_quota_exceeded") {
      const data: { retryable: true; retryAfterMs?: number } = { retryable: true };
      if (error.retryAfterMs !== undefined) data.retryAfterMs = error.retryAfterMs;
      return new McpError(OVERLOADED_JSONRPC_CODE, `${error.code}: ${error.message}`, data);
    }
    return new McpError(ErrorCode.InternalError, `${error.code}: ${error.message}`);
  }
  if (error instanceof OAuthError) {
    return new McpError(AUTH_JSONRPC_CODE, `${error.code}: ${error.message}`);
  }
  if (error instanceof CaptatumInputError) {
    const { code, message } = error.body.error;
    return new McpError(ErrorCode.InvalidParams, `${code}: ${message}`);
  }
  return new McpError(ErrorCode.InternalError, "captatum failed");
}

async function auditResult(deps: CaptatumMcpServerDeps, result: Result): Promise<void> {
  await deps.audit.writeToolEvent({
    occurredAt: new Date(deps.clock.nowMs()).toISOString(),
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: CAPTATUM_TOOL_NAME,
    url_host: urlHost(result.finalUrl),
    tier: result.tier,
    platform: result.platform.adapterId,
    output: result.output,
    status: result.code,
    bytes: result.bytes,
    durationMs: result.durationMs,
    transformProvider: result.transform?.provider,
    transformModel: result.transform?.model,
    transformCostUsd: result.transform?.costUsd,
    transformInTokens: result.transform?.inTokens,
    transformOutTokens: result.transform?.outTokens,
    transformFallbackFrom: result.transform?.fallbackFrom,
  });
}

async function auditFailure(
  deps: CaptatumMcpServerDeps,
  args: unknown,
  started: number,
  error: unknown,
): Promise<void> {
  await deps.audit.writeToolEvent({
    occurredAt: new Date(deps.clock.nowMs()).toISOString(),
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: CAPTATUM_TOOL_NAME,
    url_host: inputUrlHost(args),
    tier: "error",
    output: inputOutput(args),
    status: error instanceof OAuthError ? error.status : 0,
    bytes: 0,
    durationMs: Math.max(0, Math.round(deps.clock.nowMs() - started)),
  });
}

function inputUrlHost(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.url !== "string") return undefined;
  return urlHost(args.url);
}

function inputOutput(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.output !== "string") return undefined;
  return args.output;
}

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
