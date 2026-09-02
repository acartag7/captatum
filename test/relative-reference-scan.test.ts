// Percent-encoded credential keys on RELATIVE references must flag exactly like
// the absolute form. Executed 2026-09-01 (Level-3 re-walk, v0.20.2):
// `/cb?%61ccess_token=OPAQUE` and `/cb#%61ccess_token=OPAQUE` egressed to the
// hosted LLM (detectSensitiveTransformInput returned sensitive:false) while the
// byte-identical credential in absolute form was flagged — the relative scan
// captured the key raw; both absolute-path scanners decode via URLSearchParams.
// Spec: docs/threat-model.md §"Sensitive-content detection" (key-anchored scan).

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSensitiveTransformInput } from "../src/infrastructure/llm/safety.ts";

const SRC = "https://docs.example.com/page";

function sensitive(content: string): boolean {
  return detectSensitiveTransformInput({ content, sourceUrl: SRC }).sensitive;
}

test("percent-encoded credential keys on relative query + fragment flag (was: egressed)", () => {
  assert.equal(sensitive("see /cb?%61ccess_token=OPAQUE-SECRET here"), true);
  assert.equal(sensitive("see /cb#%61ccess_token=OPAQUE-SECRET here"), true);
  assert.equal(sensitive("see /cb?%78-amz-signature=abc123 here"), true, "x-amz-signature encoded");
});

test("controls: plain relative + encoded + plain absolute forms still flag", () => {
  assert.equal(sensitive("see /cb?access_token=OPAQUE-SECRET here"), true);
  assert.equal(sensitive("see https://x.io/cb?%61ccess_token=OPAQUE-SECRET here"), true);
  assert.equal(sensitive("see https://x.io/cb?access_token=OPAQUE-SECRET here"), true);
});

test("no false positives: clean public relative refs and ad-key carve-outs stay unflagged", () => {
  assert.equal(sensitive("see /products?id=42&sort=asc here"), false);
  assert.equal(sensitive("see /page?token=public-cdn-token&utm_source=x here"), false, "#44 ad-key carve-out");
  assert.equal(sensitive("rate is 100%61 of target"), false, "prose percent, no key=value shape");
});
