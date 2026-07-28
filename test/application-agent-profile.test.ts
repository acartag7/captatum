import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "../src/domain/result.ts";
import { resultToMcpText } from "../src/interfaces/mcp/format.ts";
import { buildStructuredContent } from "../src/interfaces/mcp/shape.ts";

const DOCUMENT = '{"is_job":true}';
const CANONICAL_LONG_TITLE = `AB${"x".repeat(137)}…`;

function result(overrides: Partial<Result> = {}): Result {
  return {
    schemaVersion: 1,
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    redirects: [],
    tier: 1,
    output: "extract",
    outputRequested: "extract",
    code: 200,
    codeText: "OK",
    bytes: 513,
    durationMs: 10,
    result: DOCUMENT,
    platform: {
      adapterId: "generic",
      label: "Generic HTML",
      detectedFrom: "tier1",
    },
    jsRequired: false,
    resolvedVia: "tier1-html",
    attempts: [{
      step: 1,
      tier: 1,
      outcome: "ok",
      status: 200,
      durationMs: 10,
      bytes: 513,
    }],
    contentType: "text/html",
    timings: { totalMs: 10, fetchMs: 10 },
    errors: [],
    transform: { provider: "test", model: "fixed-extract" },
    ...overrides,
  };
}

for (const profileCase of [
  { name: "no optional fields", title: undefined, quality: undefined },
  { name: "canonical title", title: `A\nB${"x".repeat(149)}`, quality: undefined },
  { name: "content quality", title: undefined, quality: "low_value" as const },
  {
    name: "title and content quality",
    title: `A\nB${"x".repeat(149)}`,
    quality: "low_value" as const,
  },
  { name: "empty canonical title", title: "\n\u202e\u200b", quality: undefined },
]) {
  test(`frozen application-agent profile: ${profileCase.name}`, () => {
    const withQuality = profileCase.quality === undefined
      ? {}
      : {
          contentQuality: profileCase.quality,
          errors: [{
            code: "low_value_extraction",
            message: "Fetched bytes contain little extractable text",
          }],
        };
    const value = result({ title: profileCase.title, ...withQuality });
    const receipt = buildStructuredContent(value, false);
    const expectedTitle = profileCase.title?.startsWith("A")
      ? CANONICAL_LONG_TITLE
      : undefined;
    const expectedReceipt = {
      schemaVersion: 1,
      ok: true,
      status: "pass",
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      ...(expectedTitle ? { title: expectedTitle } : {}),
      output: "extract",
      outputRequested: "extract",
      contentType: "unknown",
      result: DOCUMENT,
      tier: 1,
      code: 200,
      codeText: "OK",
      bytes: 513,
      resolvedVia: "tier1-html",
      platform: {
        adapterId: "generic",
        label: "Generic HTML",
        detectedFrom: "tier1",
      },
      jsRequired: false,
      access: {
        mainContentAccessible: true,
        gated: false,
        gateReason: "none",
      },
      ...(profileCase.quality
        ? { contentQuality: profileCase.quality }
        : {}),
      provenance: {
        tier: 1,
        resolvedVia: "tier1-html",
        code: 200,
        bytes: 513,
      },
      warnings: [],
      images: [],
      errors: [],
      transform: { provider: "test", model: "fixed-extract" },
    };
    assert.deepEqual(receipt, expectedReceipt);

    const expectedText = [
      "<!-- captatum tier=1 output=extract status=200 bytes=513 finalUrl=https://example.com/ platform=generic jsRequired=false resolvedVia=tier1-html -->",
      "",
      "contentType: unknown",
      ...(expectedTitle ? [`title: ${expectedTitle}`] : []),
      "finalUrl: https://example.com/",
      "access: public",
      ...(profileCase.quality
        ? [`contentQuality: ${profileCase.quality}`]
        : []),
      "images: 0",
      "transformModel: fixed-extract",
      "",
      DOCUMENT,
    ].join("\n");
    const text = resultToMcpText(value, false, true);
    assert.equal(text, expectedText);
    assert.equal(receipt.title, expectedTitle);
    assert.doesNotMatch(text.split("\n", 1)[0]!, /contentQuality|truncated/);
  });
}

test("non-quality warnings remain partial in the frozen profile", () => {
  const receipt = buildStructuredContent(result({
    errors: [{ code: "transform_provider_warning", message: "independent" }],
  }), false);
  assert.equal(receipt.status, "partial");
  assert.deepEqual(receipt.warnings, [{
    code: "transform_provider_warning",
    message: "independent",
  }]);
});
