import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptatumInputError, normalizeCaptatumInput } from "../src/application/use-cases/captatum-input.ts";
import { normalizeBulkInput } from "../src/application/use-cases/bulk-input.ts";
import { validateJsonSchema } from "../src/infrastructure/llm/json-schema.ts";

// Pattern bounds (adversarial assessment 2026-08-15, findings V2 + V5):
// V5 — `pattern` content must be validated at the INPUT boundary so an
//      oversized/heuristic-flagged/invalid pattern is rejected BEFORE any
//      fetch/LLM spend (it previously died only at finalize, after the bill).
// V2 — the catastrophic-shape heuristic is approximate; a semantically
//      overlapping alternation with length-differing branches ((\s|\x20)+)
//      passes it and backtracks exponentially (9.2 s @ 28 chars, synchronous
//      event-loop stall). Pattern EXECUTION is therefore wall-clock bounded on
//      a worker thread, fail-closed.

const BOMB_PATTERN = "^(\\s|\\x20)+x$"; // passes the heuristic; exponential in V8

test("input boundary rejects invalid pattern content before any fetch (single captatum)", () => {
  for (const schema of [
    { type: "string", pattern: "a".repeat(200) }, // oversized
    { type: "string", pattern: "^(a|a)+$" }, // heuristic-flagged
    { type: "string", pattern: "(" }, // syntactically invalid
    { type: "string", pattern: 5 }, // non-string
  ]) {
    assert.throws(
      () => normalizeCaptatumInput({ url: "https://public.example/", output: "extract", schema }),
      (error: unknown): boolean =>
        error instanceof CaptatumInputError && error.body.error.code === "extract_schema_invalid_pattern",
      JSON.stringify(schema).slice(0, 60),
    );
  }
});

test("input boundary rejects invalid pattern content for captatum_bulk's uniform schema too", () => {
  assert.throws(
    () => normalizeBulkInput({ urls: ["https://public.example/"], output: "extract", schema: { type: "string", pattern: "(" } }),
    (error: unknown): boolean =>
      error instanceof CaptatumInputError && error.body.error.code === "extract_schema_invalid_pattern",
  );
});

test("a legitimate pattern still passes the input boundary and validates", async () => {
  const normalized = normalizeCaptatumInput({
    url: "https://public.example/",
    output: "extract",
    schema: { type: "object", properties: { email: { type: "string", pattern: "^[^@]+@[^@]+$" } } },
  });
  assert.equal(normalized.requestedOutput, "extract");
  assert.equal(
    (await validateJsonSchema({ email: "a@b.c" }, normalized.schema)).valid,
    true,
  );
});

test("heuristic-bypass bomb: accepted at input, bounded at execution (V2 regression)", async () => {
  // The boundary still ACCEPTS this pattern (the heuristic is text-based and
  // cannot see \s ⊇ \x20) — that residual is exactly why execution must be
  // time-bounded. Unfixed code stalls the event loop: 9.2 s at 28 chars, and
  // ~2^N beyond — 40 chars is minutes, so this test only passes with the bound.
  normalizeCaptatumInput({ url: "https://public.example/", output: "extract", schema: { type: "string", pattern: BOMB_PATTERN } });
  const value = " ".repeat(40) + "y"; // matching prefix, failing suffix

  const started = Date.now();
  const result = await validateJsonSchema(value, { type: "string", pattern: BOMB_PATTERN });
  const elapsed = Date.now() - started;

  assert.equal(result.valid, false, "a timed-out pattern must fail CLOSED (not verified)");
  assert.match(result.message ?? "", /time budget/);
  assert.ok(elapsed < 3_000, `bounded execution took ${elapsed}ms — the wall-clock budget did not bind`);
});

test("a many-element pattern validation costs ONE bounded batch, not N spawns (codex P1)", async () => {
  // 100 items x a safe pattern: with per-element worker spawns + a fresh 500ms
  // budget each, this took ~5.7s. Batched: one spawn, one shared budget.
  const values = Array.from({ length: 100 }, (_, i) => `item${i}`);
  const schema = { type: "array", items: { type: "string", pattern: "^[a-z0-9]+$" } };
  const started = Date.now();
  const result = await validateJsonSchema(values, schema);
  const elapsed = Date.now() - started;
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.ok(elapsed < 1_500, `batched validation took ${elapsed}ms — per-element spawns are back`);
});

test("composite semantics survive batched patterns: anyOf/oneOf/not decide on REAL results (codex P2 r2)", async () => {
  // anyOf: "b" matches only the second branch — the deferred first pattern must
  // NOT reject it (the one-global-loop design did exactly that).
  assert.equal(
    (await validateJsonSchema("b", { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string", pattern: "^b$" }] })).valid,
    true,
  );
  assert.equal(
    (await validateJsonSchema("c", { anyOf: [{ type: "string", pattern: "^a$" }, { type: "string", pattern: "^b$" }] })).valid,
    false,
  );
  // oneOf: exactly-one match counts REAL pattern results, not deferred oks.
  assert.equal(
    (await validateJsonSchema("a", { oneOf: [{ type: "string", pattern: "^a$" }, { type: "string", pattern: "^a$" }] })).valid,
    false,
    "two matching branches = oneOf violation",
  );
  assert.equal(
    (await validateJsonSchema("a", { oneOf: [{ type: "string", pattern: "^a$" }, { type: "string", pattern: "^b$" }] })).valid,
    true,
  );
  // not: a pattern that does NOT match must not reject under not.
  assert.equal((await validateJsonSchema("b", { not: { type: "string", pattern: "^a$" } })).valid, true);
  assert.equal((await validateJsonSchema("a", { not: { type: "string", pattern: "^a$" } })).valid, false);
});

test("dotted property names do not collide with nested paths (codex P2 r3)", async () => {
  // "a.b" (a literal property whose NAME contains a dot) and a nested a>b both
  // render path $.a.b — a path-derived batch key would let one result overwrite
  // the other and report a pattern-violating payload as valid.
  const schema = {
    type: "object",
    properties: {
      "a.b": { type: "string", pattern: "^[a-z]+$" }, // "x.y" violates (dot not in [a-z])
      a: { type: "object", properties: { b: { type: "string", pattern: "^[a-z]+$" } } },
    },
  };
  const value = { "a.b": "x.y", a: { b: "ok" } };
  const result = await validateJsonSchema(value, schema);
  assert.equal(result.valid, false, "the dotted property's violation must surface");
  assert.match(result.message ?? "", /a\.b/);
  // And the symmetric case: nested violates, dotted matches.
  const result2 = await validateJsonSchema({ "a.b": "ok", a: { b: "x.y" } }, schema);
  assert.equal(result2.valid, false);
  // Clean value still passes.
  assert.equal((await validateJsonSchema({ "a.b": "ok", a: { b: "ok" } }, schema)).valid, true);
});

test("collection is independent of composite outcomes (codex P2 r4)", async () => {
  // {not:{pattern:"^a$"},pattern:"^b$"} on "b": provisional collection used to
  // treat the inner pattern as matching, FAIL the not, and stop before the
  // outer pattern — the check pass then hit an uncollected id and rejected a
  // VALID value as unverified. Collection must descend past every provisional
  // composite outcome.
  assert.equal(
    (await validateJsonSchema("b", { not: { type: "string", pattern: "^a$" }, type: "string", pattern: "^b$" })).valid,
    true,
  );
  // and the symmetric violating case still fails
  assert.equal(
    (await validateJsonSchema("a", { not: { type: "string", pattern: "^a$" }, type: "string", pattern: "^b$" })).valid,
    false,
  );
  // oneOf provisional double-count must not orphan a later sibling pattern either
  assert.equal(
    (await validateJsonSchema("x", { oneOf: [{ type: "string", pattern: "^x$" }, { type: "string", pattern: "^x$" }] })).valid,
    false,
    "exactly-one violated",
  );
});
