import type { RenderAction, RenderOutput } from "../ports/renderer.ts";
import type { RenderDiagnostics } from "../../domain/result.ts";

/**
 * Build the renderDiagnostics block for a Tier-3 render-FAILURE outcome (#154). Pure (no side
 * effects); the caller (render.ts) attaches it to `result.renderDiagnostics` on render_empty +
 * render-error. `egressBytes` is the Tier-3-ONLY subresource value (rendered.egressBytes — NOT
 * Result.egressBytes, which is tier1Bytes + renderEgress and is never 0 on a render_empty that
 * followed a Tier-1 fetch — the BLOCKER the critique caught). renderEgressHosts is the RAW set
 * (registrable-domain OR bare-host fallback, incl. public IP literals); the OUTPUT shaper filters
 * it to registrable domains + a redacted [ip-literal] sentinel at the trust boundary (never a raw
 * IP). domTextLength is the browser's live DOM text (captures shadow-DOM/computed text the
 * serialized-HTML extractor misses) — it splits a page whose DOM HAS text the extractor dropped
 * (extraction-gap) from a wall/stub (empty-dom / unknown).
 */
export function buildRenderDiagnostics(rendered: RenderOutput): RenderDiagnostics {
  const actions: readonly RenderAction[] = rendered.actions ?? [];
  const renderEgressHosts = rendered.egressHosts ?? [];
  const domTextLength = rendered.rendered ? rendered.domTextLength : undefined;
  return {
    ...(rendered.rendered ? { renderedBytes: rendered.fetchResult.bytes, ...(domTextLength !== undefined ? { domTextLength } : {}) } : {}),
    egressBytes: rendered.egressBytes ?? 0,
    renderEgressHosts,
    blockedRequests: countByType(actions, BLOCKED_TYPES),
    forwardedRequests: countByType(actions, ["request-forwarded-post"]),
    possibleReason: classifyRenderFailure(rendered, domTextLength),
  };
}

/** Conservative possibleReason classifier. NEVER a confident diagnosis — the render outcome is
 *  untrusted; an unclear cause is `unknown`. First match wins. `bot-wall` is deliberately NOT a
 *  reason: it can't be reliably split from extraction-gap/empty-dom by static signals, and a
 *  confident wrong label is worse than `unknown` (the #151 gateReason antibot signal rides
 *  separately when attributable). */
export function classifyRenderFailure(
  rendered: RenderOutput,
  domTextLength: number | undefined,
): RenderDiagnostics["possibleReason"] {
  if (!rendered.rendered) return "render-error"; // renderer threw / no DOM produced
  const egress = rendered.egressBytes ?? 0;
  const hosts = rendered.egressHosts ?? [];
  if (egress === 0 && hosts.length === 0) return "network-blocked"; // DOM present but nothing loaded
  const text = domTextLength ?? 0;
  if (rendered.fetchResult.bytes >= EXTRACTION_GAP_BYTES && text >= DOM_TEXT_PRESENT) return "extraction-gap";
  if (rendered.fetchResult.bytes < EMPTY_DOM_BYTES && text < DOM_TEXT_PRESENT) return "empty-dom";
  return "unknown";
}

const BLOCKED_TYPES = ["request-blocked", "resource-aborted", "download-blocked", "websocket-closed", "popup-closed"];

function countByType(actions: readonly RenderAction[], types: readonly string[]): number {
  let n = 0;
  for (const a of actions) if (types.includes(a.type)) n++;
  return n;
}

/** A DOM ≥ this many bytes is non-trivial (a real page body, not a stub). Impl-detail (non-frozen
 *  tests pin the boundary against real SPA shells). */
export const EXTRACTION_GAP_BYTES = 4096;
/** A DOM below this is a near-empty SPA shell. Calibrated against real shells (a stub is < 2KB). */
export const EMPTY_DOM_BYTES = 2048;
/** domTextLength ≥ this means the DOM HAS visible text (the extractor dropped it → extraction-gap). */
export const DOM_TEXT_PRESENT = 100;
