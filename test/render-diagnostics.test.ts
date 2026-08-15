// Non-frozen impl-detail tests for #154: the output-boundary IP filter (redactEgressHost — the
// security pin) + the classifier thresholds. The CONTRACT is pinned effects-only in the frozen
// test/acceptance/154/. Per [[captatum-frozen-suite-contract-only]], impl-detail guards live here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEgressHost, shapeRenderDiagnostics } from "../src/interfaces/mcp/egress-shaping.ts";
import {
  classifyRenderFailure,
  EXTRACTION_GAP_BYTES,
  EMPTY_DOM_BYTES,
  DOM_TEXT_PRESENT,
  buildRenderDiagnostics,
} from "../src/application/use-cases/render-diagnostics.ts";
import { maybeRender } from "../src/application/use-cases/render.ts";
import type { RenderOutput, RenderPort } from "../src/application/ports/renderer.ts";
import type { RenderDiagnostics } from "../src/domain/result.ts";

test("#154 redactEgressHost: registrable domain kept; IP / single-label / IPv6 → [ip-literal]", () => {
  assert.equal(redactEgressHost("example.com"), "example.com");
  assert.equal(redactEgressHost("sub.example.com"), "example.com"); // normalized to registrable
  assert.equal(redactEgressHost("93.184.216.34"), "[ip-literal]", "public IPv4 never leaks");
  assert.equal(redactEgressHost("localhost"), "[ip-literal]", "single-label redacted");
  assert.equal(redactEgressHost("[::1]"), "[ip-literal]", "IPv6 literal redacted");
});

test("popup-closed counts toward blockedRequests in render diagnostics (codex P2 r2)", () => {
  // A page that opened popups and then failed the render: the closed-popups
  // control fired and the blocked tally must report it alongside the others.
  const fail = {
    rendered: false,
    code: "render_error",
    message: "x",
    actions: [
      { type: "popup-closed", reason: "popups disabled", url: "http://popup.test/x" },
      { type: "request-blocked", reason: "private_address", url: "http://10.0.0.1/a", resourceType: "script" },
      { type: "service-workers-disabled", reason: "context serviceWorkers=block" },
    ],
  } as unknown as RenderOutput;
  const diagnostics = buildRenderDiagnostics(fail);
  assert.equal(diagnostics.blockedRequests, 2, "popup-closed + request-blocked; service-workers is not a block");
});

test("#154 classifyRenderFailure: !rendered → render-error", () => {
  const fail = { rendered: false, actions: [], code: "render_timeout", message: "x" } as unknown as RenderOutput;
  assert.equal(classifyRenderFailure(fail, undefined), "render-error");
});

test("#154 classifyRenderFailure: network-blocked when DOM present + Tier-3 egress 0 + no hosts", () => {
  const ok = { rendered: true, fetchResult: { bytes: 60_000 }, actions: [], egressBytes: 0, egressHosts: [] } as unknown as RenderOutput;
  assert.equal(classifyRenderFailure(ok, 8000), "network-blocked");
});

test("#154 classifyRenderFailure: extraction-gap (high DOM + high text) / empty-dom (low + low) / unknown (high DOM + low text)", () => {
  const mk = (bytes: number, egress = 40_000): RenderOutput =>
    ({ rendered: true, fetchResult: { bytes }, actions: [], egressBytes: egress, egressHosts: ["app.test"] } as unknown as RenderOutput);
  assert.equal(classifyRenderFailure(mk(60_000), 8000), "extraction-gap");
  assert.equal(classifyRenderFailure(mk(40), 2), "empty-dom");
  assert.equal(classifyRenderFailure(mk(60_000), 3), "unknown", "high DOM + LOW text → unknown (not a confident wall label)");
});

test("#154 thresholds are the calibrated constants (impl-detail pin)", () => {
  assert.equal(EXTRACTION_GAP_BYTES, 4096);
  assert.equal(EMPTY_DOM_BYTES, 2048);
  assert.equal(DOM_TEXT_PRESENT, 100);
});

test("#154 shapeRenderDiagnostics caps + dedups renderEgressHosts (attacker-influenced set)", () => {
  // The page chooses its subresource hosts, so the set is attacker-influenced (receipt bloat /
  // covert channel). The output caps the cardinality (8) + collapses duplicate domains / IPs.
  // Distinct registrable domains (site0.com … site11.com — each its own eTLD+1, so no dedup collapse).
  const many: RenderDiagnostics = { renderEgressHosts: Array.from({ length: 12 }, (_, i) => `site${i}.com`), blockedRequests: 0, forwardedRequests: 0, possibleReason: "unknown" };
  const capped = shapeRenderDiagnostics(many).renderEgressHosts as string[];
  assert.equal(capped.length, 8, "capped at 8 (7 + a count)");
  assert.match(capped[7], /\(\+5 more\)/, "the trailing entry is a count, not more page-chosen strings");
  // N distinct IPs collapse to a single [ip-literal] (deduped); a subdomain normalizes to its
  // registrable domain (app.example.com → example.com — the redaction surfaces eTLD+1, not the subdomain).
  const ips: RenderDiagnostics = { renderEgressHosts: ["1.2.3.4", "5.6.7.8", "app.example.com"], blockedRequests: 0, forwardedRequests: 0, possibleReason: "unknown" };
  assert.deepEqual(shapeRenderDiagnostics(ips).renderEgressHosts, ["[ip-literal]", "example.com"]);
  // Compact (includeHosts=false): possibleReason/counts kept; renderEgressHosts omitted (the bloat field).
  const compact = shapeRenderDiagnostics({ renderEgressHosts: ["site0.com", "site1.com"], blockedRequests: 2, forwardedRequests: 0, possibleReason: "extraction-gap", renderedBytes: 5000 }, false);
  assert.equal(compact.possibleReason, "extraction-gap", "compact keeps possibleReason");
  assert.equal(compact.blockedRequests, 2, "compact keeps counts");
  assert.equal(compact.renderEgressHosts, undefined, "compact omits the hosts list (25KB ceiling)");
});

test("#154 no renderDiagnostics when the renderer returns code render_unavailable (hosted no-CDP path — codex P2)", async () => {
  // unavailableRenderer() returns {rendered:false, code:"render_unavailable"} — no render ran, so
  // no diagnostics (the contract). C7 covers the undefined-renderer path; this covers the
  // renderer-returns-unavailable path (the gate at render.ts maybeRender).
  const result = await maybeRender({
    result: { url: "https://x.test/", bytes: 1, code: 200, codeText: "OK", durationMs: 0, result: "", schemaVersion: 1, finalUrl: "https://x.test/", redirects: [], tier: 1, output: "raw" as const, platform: { adapterId: "generic", label: "g", detectedFrom: "tier1" }, jsRequired: true, resolvedVia: "tier1-shell-gate", attempts: [], contentType: "text/html", timings: { totalMs: 0, fetchMs: 0 }, errors: [] },
    request: { url: "https://x.test/", prompt: "", requestedOutput: "raw" as const, maxBytes: 5_000_000, timeoutMs: 15_000, renderTimeoutMs: 20_000, maxHops: 5, allowRender: true, debug: false },
    renderer: { render: async () => ({ rendered: false, rejected: true, code: "render_unavailable", message: "no browser", actions: [] }) } as RenderPort,
    fetcher: { async fetchGuarded() { throw new Error("unused"); } },
    extractHtml: () => ({ title: undefined, text: "", structured: {}, shellGate: { jsRequired: true, reason: "empty-spa-shell", textLength: 0, wordCount: 0, scriptCount: 0, appRootFound: false, structuredDataFound: false }, errors: [] }),
    clock: { nowMs: () => 0 },
  });
  assert.equal(result.renderDiagnostics, undefined, "render_unavailable (renderer returned unavailable) carries no diagnostics");
  assert.equal(result.tier, "render-unavailable");
});

test("#154 a real render failure (NOT unavailable) DOES get diagnostics", async () => {
  // A genuine render failure (code render_error, not render_unavailable) → renderDiagnostics present.
  const result = await maybeRender({
    result: { url: "https://x.test/", bytes: 1, code: 200, codeText: "OK", durationMs: 0, result: "", schemaVersion: 1, finalUrl: "https://x.test/", redirects: [], tier: 1, output: "raw" as const, platform: { adapterId: "generic", label: "g", detectedFrom: "tier1" }, jsRequired: true, resolvedVia: "tier1-shell-gate", attempts: [], contentType: "text/html", timings: { totalMs: 0, fetchMs: 0 }, errors: [] },
    request: { url: "https://x.test/", prompt: "", requestedOutput: "raw" as const, maxBytes: 5_000_000, timeoutMs: 15_000, renderTimeoutMs: 20_000, maxHops: 5, allowRender: true, debug: false },
    renderer: { render: async () => ({ rendered: false, rejected: true, code: "render_error", message: "boom", actions: [] }) } as RenderPort,
    fetcher: { async fetchGuarded() { throw new Error("unused"); } },
    extractHtml: () => ({ title: undefined, text: "", structured: {}, shellGate: { jsRequired: true, reason: "empty-spa-shell", textLength: 0, wordCount: 0, scriptCount: 0, appRootFound: false, structuredDataFound: false }, errors: [] }),
    clock: { nowMs: () => 0 },
  });
  assert.equal(result.renderDiagnostics?.possibleReason, "render-error");
});
