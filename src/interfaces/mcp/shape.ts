import type { ProvenanceError, Result, TransformInfo } from "../../domain/result.ts";
import { classifyAccess, classifyContentType, hasContent, type AccessInfo, type ContentType } from "../../application/classify.ts";
import { redactSignedQueryParams } from "../../infrastructure/llm/safety.ts";
import { shapeRenderDiagnostics } from "./egress-shaping.ts";
import {
  canonicalApplicationAgentTitle,
  isApplicationAgentProfile,
} from "./application-agent-profile.ts";

export type Status = "pass" | "partial" | "fail";

/**
 * Build the agent-facing MCP `structuredContent`. The default is a LEAN payload:
 * the load-bearing primitives agents/connectors already read (`result`, `tier`,
 * `title`, `output`, `code`, `bytes`, …) plus the new tiered fields (`ok`,
 * `status`, `contentType`, `access`, `provenance`, `warnings`, `images`) and a
 * lean transform. Heavy diagnostic fields (attempts, timings, full structured
 * data incl. JSON-LD description/articleBody, redirects, hashes) are gated
 * behind `debug: true`. The domain `Result` is never mutated.
 */
export function buildStructuredContent(result: Result, debug: boolean): Record<string, unknown> {
  const contentType = classifyContentType(result);
  const access = classifyAccess(result);
  const profile = isApplicationAgentProfile(result, debug);
  const split = splitErrors(result);
  const warnings = profile
    ? split.warnings.filter((warning) => warning.code !== "low_value_extraction")
    : split.warnings;
  const errors = split.errors;
  const status = classifyStatus(result, warnings);
  const title = profile
    ? canonicalApplicationAgentTitle(result.title)
    : result.title;

  const lean: Record<string, unknown> = {
    schemaVersion: result.schemaVersion,
    ok: status !== "fail",
    status,
    url: redactSignedQueryParams(result.url),
    finalUrl: redactSignedQueryParams(result.finalUrl),
    title,
    output: result.output,
    ...(result.outputRequested !== undefined ? { outputRequested: result.outputRequested } : {}),
    contentType,
    result: snippet(result.result),
    tier: result.tier,
    code: result.code,
    codeText: result.codeText,
    bytes: result.bytes,
    resolvedVia: result.resolvedVia,
    platform: result.platform,
    jsRequired: result.jsRequired,
    access,
    ...(result.contentQuality ? { contentQuality: result.contentQuality } : {}),
    provenance: {
      tier: result.tier,
      resolvedVia: result.resolvedVia,
      code: result.code,
      bytes: result.bytes,
    },
    warnings,
    images: result.structured?.images ?? [],
    errors,
    // Network-egress truth (parity with bulk's per-row field) + render-failure diagnostics (#154).
    ...(result.egressBytes !== undefined ? { egressBytes: result.egressBytes } : {}),
    ...(result.renderDiagnostics ? { renderDiagnostics: shapeRenderDiagnostics(result.renderDiagnostics) } : {}),
  };

  const transform = leanTransform(result.transform);
  if (transform) lean.transform = transform;

  if (debug) Object.assign(lean, debugFields(result));
  return prune(lean);
}

/** Fatal errors only surface when the run failed (`tier: "error"`); the rest are non-fatal warnings. */
function splitErrors(result: Result): { errors: ProvenanceError[]; warnings: ProvenanceError[] } {
  const fatal = result.tier === "error";
  const warnings = result.errors.filter((error) => !fatal || error.code === "schema_knob_extracted");
  return {
    errors: fatal ? result.errors.filter((error) => error.code !== "schema_knob_extracted") : [],
    warnings: fatal ? warnings : result.errors,
  };
}

function classifyStatus(result: Result, warnings: ProvenanceError[]): Status {
  if (result.tier === "error" || !hasContent(result)) return "fail";
  // HTTP error (4xx/5xx): the body is an error page, not usable content — fail honestly
  // even though a body was returned (the agent can still read result.result for the message).
  if (Number(result.code) >= 400) return "fail";
  if (warnings.length > 0) return "partial";
  // Summary/extract requested but the transform fell back to raw — degraded. provider:"none" is
  // set ONLY on a degrade, so any reason ⇒ partial (#153 conformance fix: the old reason allowlist
  // — "failed"||"unconfigured" — under-reported router sub-reasons like no_model_fit as "pass").
  const t = result.transform;
  if (t && t.provider === "none") {
    return "partial";
  }
  return "pass";
}

/** Token-efficiency + fallback signal only; latency/cost/schemaIssue move to debug. */
function leanTransform(transform: TransformInfo | undefined): Record<string, unknown> | undefined {
  if (!transform) return undefined;
  const lean: Record<string, unknown> = { provider: transform.provider };
  if (transform.model !== undefined) lean.model = transform.model;
  if (transform.free !== undefined) lean.free = transform.free;
  if (transform.inTokens !== undefined) lean.inTokens = transform.inTokens;
  if (transform.outTokens !== undefined) lean.outTokens = transform.outTokens;
  // reason is small and load-bearing: "failed"/"unconfigured" distinguishes a
  // silent raw fallback from a real summary without inspecting `status`.
  if (transform.reason !== undefined) lean.reason = transform.reason;
  return lean;
}

/** Heavy fields unlocked by `debug: true`, including the full structured payload. */
function debugFields(result: Result): Record<string, unknown> {
  const debug: Record<string, unknown> = {
    attempts: result.attempts,
    timings: result.timings,
    redirects: result.redirects,
    durationMs: result.durationMs,
    httpContentType: result.contentType,
    structured: result.structured,
  };
  if (result.contentSha256 !== undefined) debug.contentSha256 = result.contentSha256;
  if (result.provenanceHash !== undefined) debug.provenanceHash = result.provenanceHash;
  if (result.transform) debug.transform = { ...result.transform };
  return debug;
}

/** Drop top-level `undefined` values so the payload carries no empty keys. */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) out[key] = val;
  }
  return out;
}

/**
 * The full result text is already delivered as the MCP `content[0].text` (the
 * primary agent channel). Mirroring it again verbatim in `structuredContent`
 * duplicates a large body into model context whenever a client passes the
 * structured payload to the model. Bound it to a snippet here; the full text
 * remains in `content[0].text`. Summaries are small and pass through unchanged.
 */
const RESULT_SNIPPET_CHARS = 2_000;

function snippet(text: string): string {
  if (text.length <= RESULT_SNIPPET_CHARS) return text;
  const head = text.slice(0, RESULT_SNIPPET_CHARS).trimEnd();
  return `${head}\n\n[… ${text.length} characters total — snippeted in this lean payload; the full text is delivered in the tool result's content[0].text (the canonical MCP content channel).]`;
}

export type { ContentType, AccessInfo };
