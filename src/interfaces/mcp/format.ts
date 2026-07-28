import type { AttemptTrace, Result } from "../../domain/result.ts";
import { classifyAccess, classifyContentType, truncatedReason } from "../../application/classify.ts";
import { isJsonContentType } from "../../infrastructure/http/body.ts";
import { redactSignedQueryParams } from "../../infrastructure/llm/safety.ts";
import { canonicalApplicationAgentTitle } from "./application-agent-profile.ts";

/** Max attempt lines emitted in the debug text block (MCP debug + CLI --debug). */
const DEBUG_ATTEMPTS_CAP = 50;

function formatAttempt(a: AttemptTrace): string {
  return `attempt ${a.step}: tier ${a.tier} ${a.outcome}${a.status !== undefined ? ` ${a.status}` : ""} ${a.durationMs}ms${a.reason ? ` (${a.reason})` : ""}`;
}

/**
 * The MCP text returned to the caller: a machine provenance comment (always
 * present, model-visible), then a deterministic envelope header (for non-raw
 * outputs), then the result body. Raw output is unchanged so the contract
 * fixtures (all raw) stay byte-identical.
 */
export function resultToMcpText(
  result: Result,
  includeTextDebug = false,
  frozenApplicationAgentProfile = false,
): string {
  const provenance = provenanceLine(result, frozenApplicationAgentProfile);
  if (result.output === "raw") {
    // A raw JSON body (application/json or +json) stays parseable JSON for clients that read
    // content[0].text as JSON, so omit the comment — UNLESS the body was truncated. A truncated
    // JSON body is partial/unparseable anyway (the "stay parseable" rationale no longer holds),
    // so prepend the provenance comment (carrying truncated=) so a text-forward/CLI client still
    // sees the transport-unreliable signal (#149 codex P1). HTML/text raw always gets the comment.
    if (isJsonBody(result)) {
      const truncated = truncatedReason(result) !== undefined;
      return truncated ? `${provenance}\n${result.result}` : result.result;
    }
    return `${provenance}\n${result.result}`;
  }
  const header = envelopeHeader(result, frozenApplicationAgentProfile);
  const base = header ? `${provenance}\n\n${header}\n\n${result.result}` : `${provenance}\n${result.result}`;
  // #45: for text-forward clients (which render content[0].text but not structuredContent), surface a
  // compact diagnostics block inline so `debug:true` is actually visible there.
  return includeTextDebug ? `${base}\n\n${debugTextBlock(result)}` : base;
}

/**
 * A compact, human-readable diagnostics block for the TEXT channel (text-forward clients, debug on).
 * Mirrors the subset of the debug `structuredContent` fields that matter for triaging a fetch, so a
 * connector that can't render structuredContent still sees how the result was produced.
 */
export function debugTextBlock(result: Result): string {
  const lines: string[] = [
    "--- debug ---",
    `tier: ${result.tier}  resolvedVia: ${result.resolvedVia}  status: ${result.code}  bytes: ${result.bytes}  durationMs: ${result.durationMs}  jsRequired: ${result.jsRequired}`,
  ];
  // Cap attempts so a page that blocks many sub-resources can't turn this compact
  // diagnostics block into thousands of model-visible lines (the debug text channel
  // is shared by the MCP debug block and the CLI --debug block). When capping, keep
  // the FIRST (cap-1) and ALWAYS the terminal attempt — the last is often the
  // render/fetch failure reason, the most diagnostic line in the high-attempt case.
  const total = result.attempts.length;
  if (total <= DEBUG_ATTEMPTS_CAP) {
    for (const a of result.attempts) lines.push(formatAttempt(a));
  } else {
    const head = result.attempts.slice(0, DEBUG_ATTEMPTS_CAP - 1);
    for (const a of head) lines.push(formatAttempt(a));
    lines.push(`(+${total - DEBUG_ATTEMPTS_CAP} more attempts not shown)`);
    lines.push(formatAttempt(result.attempts[total - 1]));
  }
  if (result.transform) {
    const t = result.transform;
    lines.push(`transform: ${t.provider}${t.model ? ` ${t.model}` : ""}${t.reason ? ` (${t.reason})` : ""}${t.inTokens !== undefined ? ` in=${t.inTokens}` : ""}${t.outTokens !== undefined ? ` out=${t.outTokens}` : ""}${t.fallbackFrom ? ` fallbackFrom=${t.fallbackFrom}` : ""}`);
  }
  if (result.contentSha256) lines.push(`contentSha256: ${result.contentSha256}`);
  return lines.join("\n");
}

function isJsonBody(result: Result): boolean {
  // Same predicate as the Tier-1 JSON route (infrastructure/http/body.ts): a +json suffix
  // (application/vnd.api+json, application/ld+json, …) is also a single parseable JSON document
  // and must skip the prepended provenance comment, or content[0].text stops being valid JSON.
  return isJsonContentType(result.contentType);
}

/**
 * Backend-generated (not LLM) envelope summary, prepended to summary/extract
 * text so EVERY client sees the key fields — including clients (e.g. Claude
 * Code) that surface the `content` text but not the full `structuredContent`.
 * Deterministic, so it never contradicts itself or says a present field is
 * "not provided". Raw output is excluded (the caller asked for clean content).
 */
function envelopeHeader(result: Result, frozenProfile: boolean): string {
  const access = classifyAccess(result);
  const images = result.structured?.images ?? [];
  const title = frozenProfile
    ? canonicalApplicationAgentTitle(result.title)
    : result.title
      ? clip(sanitizePrintable(result.title), 140)
      : undefined;
  const lines: Array<string | null> = [
    `contentType: ${classifyContentType(result)}`,
    title ? `title: ${title}` : null,
    `finalUrl: ${redactSignedQueryParams(result.finalUrl)}`,
    `access: ${access.gated ? `gated (${access.gateReason}${access.challengeProvider ? `: ${access.challengeProvider}` : ""})` : "public"}`,
    result.contentQuality ? `contentQuality: ${result.contentQuality}` : null,
    `images: ${images.length}${images[0] ? ` (e.g. ${images[0]})` : ""}`,
    result.transform?.model ? `transformModel: ${result.transform.model}` : null,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function provenanceLine(
  result: Result,
  frozenProfile: boolean,
): string {
  // Surface a truncation indicator in the provenance comment — the most reliable model-visible
  // channel (present for every output mode, incl. raw where there is no envelope header). A
  // text-forward client that renders only content[0].text thus still sees that the bytes are
  // incomplete: `truncated=max_bytes` (clean cap prefix) or `truncated=body_read_error`
  // (transport-truncated, may be garbled). `truncatedReason` excludes a zero-byte total failure
  // (tier:error) — that is a failed fetch, not partial content (#149 codex P2).
  const truncationCode = truncatedReason(result);
  const fields: Array<[string, string]> = [
    ["tier", String(result.tier)],
    ["output", result.output],
    ["status", String(result.code)],
    ["bytes", String(result.bytes)],
    ...(!frozenProfile && truncationCode
      ? [["truncated", truncationCode] as [string, string]]
      : []),
    // contentQuality rides the provenance comment (not just the envelope header) so a low_value
    // result returned as output:raw still signals "HTTP success ≠ usable content" to a text-forward
    // client reading only content[0].text (#159 codex). Absent for normal content.
    ...(!frozenProfile && result.contentQuality
      ? [["contentQuality", result.contentQuality] as [string, string]]
      : []),
    ["finalUrl", redactSignedQueryParams(result.finalUrl)],
    ["platform", result.platform.adapterId],
    ["jsRequired", String(result.jsRequired)],
    ["resolvedVia", result.resolvedVia],
  ];
  return `<!-- captatum ${fields.map(([key, value]) => `${key}=${escapeField(value)}`).join(" ")} -->`;
}

function escapeField(value: string): string {
  return JSON.stringify(value).slice(1, -1).replaceAll("--", "\\u002d\\u002d");
}

/** Strip ALL control chars (incl. CR/LF — header-line forging), bidi overrides,
 *  and zero-width chars from untrusted display fields (INJ-7). */
function sanitizePrintable(value: string): string {
  return value.replace(/[\x00-\x1f\x7f​-‏‪-‮]/g, "");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
