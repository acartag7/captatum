import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelPick, ModelRouterPort, ModelScore } from "../src/application/ports/model-router.ts";
import { TransformError, type TransformInput } from "../src/application/ports/transformer.ts";
import { finalize } from "../src/infrastructure/llm/finalize.ts";

class RecordingRouter implements ModelRouterPort {
  readonly calls: ModelScore[] = [];
  pick(): ModelPick {
    return { provider: "none", reason: "test" };
  }
  feedback(score: ModelScore): void {
    this.calls.push(score);
  }
}

function input(mode: "summarize" | "extract", schema?: unknown): TransformInput {
  return {
    mode,
    output: mode === "extract" ? "extract" : "summary",
    content: "source",
    prompt: "p",
    schema,
  };
}

test("finalize records one 'success' outcome on a clean summary", async () => {
  const router = new RecordingRouter();
  await finalize(input("summarize"), "a good summary", "m", router);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "success");
});

test("finalize records one 'success' outcome on a schema-valid extract", async () => {
  const router = new RecordingRouter();
  await finalize(input("extract", { type: "object", properties: { a: { type: "string" } } }), '{"a":"x"}', "m", router);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "success");
});

test("finalize records one 'soft' outcome on a schema mismatch — no follow-up success", async () => {
  // The mismatch path records 'soft' (NOT a hard failure — garbage-ish output is tolerated and
  // must not feed demotion); finalize must not then also record 'success' (one outcome per attempt).
  const router = new RecordingRouter();
  const out = await finalize(
    input("extract", { type: "object", properties: { a: { type: "string" } } }),
    '{"a":123}',
    "m",
    router,
  );
  assert.ok(out.schemaIssue);
  assert.equal(router.calls.length, 1, "expected only the soft outcome, no follow-up success");
  assert.equal(router.calls[0].outcome, "soft");
});

test("finalize records one 'hard_fail' outcome (and fails closed) for an unsupported schema keyword", async () => {
  const router = new RecordingRouter();
  // #153: the retained defense-in-depth throw carries the rephrased message (leads with the
  // offending key — the captatum.ts catch maps this code to reason "schema_validation_failed").
  await assert.rejects(
    async () => await finalize(
      input("extract", { type: "object", properties: { a: { type: "string", format: "email" } } }),
      '{"a":"x"}',
      "m",
      router,
    ),
    (err: unknown): boolean =>
      err instanceof TransformError
      && err.code === "extract_schema_invalid"
      && err.message.startsWith('Unsupported JSON Schema keyword "format"'),
  );
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "hard_fail");
});
