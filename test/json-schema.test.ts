import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchema } from "../src/infrastructure/llm/json-schema.ts";
import { findUnsupportedSchemaKeyword, messageForUnsupportedKeyword } from "../src/domain/schema-allowlist.ts";

// PR 8: JSON-Schema validation correctness. The `in` operator walks the prototype
// chain, so own `constructor`/`toString` keys were masked by inherited ones and
// slipped past additionalProperties:false / required; and JSON.stringify-based
// deep equality treated reordered-key objects as distinct, weakening
// uniqueItems/enum/const.

test("additionalProperties:false rejects an own constructor/toString key (not masked by the inherited one)", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  assert.equal((await validateJsonSchema({ name: "x", constructor: "evil" }, schema)).valid, false);
  assert.equal((await validateJsonSchema({ name: "x", toString: "evil" }, schema)).valid, false);
  assert.equal((await validateJsonSchema({ name: "x" }, schema)).valid, true);
});

test("uniqueItems rejects duplicate objects whose keys are in a different order", async () => {
  const schema = { type: "array", uniqueItems: true };
  assert.equal((await validateJsonSchema([{ a: 1, b: 2 }, { b: 2, a: 1 }], schema)).valid, false);
  assert.equal((await validateJsonSchema([{ a: 1, b: 2 }, { a: 1, b: 3 }], schema)).valid, true);
});

test("enum/const treat reordered-key objects as equal (canonical deep equality)", async () => {
  assert.equal((await validateJsonSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] })).valid, true);
  assert.equal((await validateJsonSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } })).valid, true);
});

test("required checks own properties, not inherited ones", async () => {
  const schema = { type: "object", required: ["constructor"] };
  // `constructor` exists on the prototype but not as an own property of {}.
  assert.equal((await validateJsonSchema({ name: "x" }, schema)).valid, false);
});

test("schema pattern with nested quantifiers is rejected as unsupported (TRANSFORM-2)", async () => {
  const r = await validateJsonSchema("aaa", { pattern: "^(a+)+$" });
  assert.equal(r.valid, false);
  assert.equal(r.unsupported, true, "catastrophic pattern must be rejected as unsupported");
});

test("schema pattern with wrapped nested quantifiers is rejected (TRANSFORM-2)", async () => {
  // ((a+))+ — the inner group's quantifier propagates to the enclosing group.
  assert.equal((await validateJsonSchema("aaa", { pattern: "^((a+))+$" })).unsupported, true);
});

test("schema pattern with duplicate- or prefix-overlap alternation is rejected (TRANSFORM-2)", async () => {
  // (a|a)+ exact-duplicate overlap and (a|aa)+ / (a|ab)+ prefix-overlap: distinct
  // branches that can both match the same input, so a quantifier backtracks hard.
  assert.equal((await validateJsonSchema("aaa", { pattern: "^(a|a)+$" })).unsupported, true);
  assert.equal((await validateJsonSchema("aaa", { pattern: "^(a|aa)+$" })).unsupported, true);
  assert.equal((await validateJsonSchema("aab", { pattern: "^(a|ab)+$" })).unsupported, true);
  // wrapped overlap ((a|a))+ — the inner overlap must propagate to the outer quantifier.
  assert.equal((await validateJsonSchema("aaa", { pattern: "^((a|a))+$" })).unsupported, true);
  // disjoint alternation (a|b)+ is safe and must NOT be rejected.
  assert.equal((await validateJsonSchema("ab", { pattern: "^(a|b)+$" })).unsupported, undefined);
});

test("schema pattern with a quantified group that is NOT repeated stays valid (TRANSFORM-2 FP guard)", async () => {
  // ([0-9]+) contains a quantifier but is not itself quantified -> safe.
  const r = await validateJsonSchema("123", { pattern: "^([0-9]+)$" });
  assert.equal(r.valid, true);
  assert.notEqual(r.unsupported, true);
});

test("schema pattern on a value over the 8 KiB cap surfaces as unverified, not silently accepted", async () => {
  const r = await validateJsonSchema("a".repeat(9000) + "!", { pattern: "^[a]+$" });
  assert.equal(r.valid, false);
  assert.match(r.message ?? "", /8 KiB pattern-validation cap/);
});

test("schema pattern exceeding the length cap is rejected (TRANSFORM-2)", async () => {
  assert.equal((await validateJsonSchema("x", { pattern: "a".repeat(200) })).valid, false);
});

test("a normal schema pattern still validates (TRANSFORM-2 regression)", async () => {
  assert.equal((await validateJsonSchema("12345", { pattern: "^\\d+$" })).valid, true);
  assert.equal((await validateJsonSchema("abc", { pattern: "^\\d+$" })).valid, false);
});

// #153: the unsupported-keyword message leads with the offending key (the pre-fix `${path} schema
// keyword "${key}"` visually merged `$` + `schema` into `$schema`, implicating the supported key).
test("#153: validateJsonSchema unsupported-keyword message leads with the offending key", async () => {
  const r = await validateJsonSchema({ a: "x" }, { type: "object", properties: { a: { type: "string", format: "email" } } });
  assert.equal(r.unsupported, true);
  assert.ok(r.message?.startsWith('Unsupported JSON Schema keyword "format"'), `got: ${r.message}`);
  assert.ok(!r.message?.includes("$schema keyword"), "must not visually merge into '$schema keyword'");
});

// #153: the input-boundary walker visits exactly the applied-subschema locations validateAt visits —
// it must NOT visit $defs/definitions (dead — no $ref support) or it would over-reject schemas the
// value validator accepts.
test("#153: findUnsupportedSchemaKeyword does not visit $defs/definitions (no $ref support)", async () => {
  // `format` lives only inside $defs — never applied to the value, so it is harmless and must NOT
  // be flagged (the value validator accepts this schema today).
  const schema = { type: "object", properties: { a: { type: "string" } }, $defs: { x: { format: "email" } } };
  assert.equal(findUnsupportedSchemaKeyword(schema), undefined);
});

test("#153: findUnsupportedSchemaKeyword flags tuple-form items as a fail-closed unverifiable form", async () => {
  // `items` as an array (tuple) can only be advisory-checked by the value validator (invalid,
  // unsupported unset), so the walker hard-rejects the unverifiable form at the input boundary.
  const schema = { type: "array", items: [{ type: "string", format: "email" }] };
  const finding = findUnsupportedSchemaKeyword(schema);
  assert.equal(finding?.kind, "tuple_items");
  assert.equal(finding?.path, "$.items");
  // single-schema items is still recursed (a nested unsupported keyword there is caught normally)
  assert.equal(
    findUnsupportedSchemaKeyword({ type: "array", items: { type: "string", format: "email" } })?.kind,
    "unsupported",
  );
});

test("#153: findUnsupportedSchemaKeyword reports a root unsupported keyword + a nested one with its path", async () => {
  assert.deepEqual(findUnsupportedSchemaKeyword({ type: "object", budget: 1 }), { kind: "unsupported", key: "budget", path: "$" });
  assert.deepEqual(
    findUnsupportedSchemaKeyword({ type: "object", properties: { email: { type: "string", format: "email" } } }),
    { kind: "unsupported", key: "format", path: "$.properties.email" },
  );
});

test("#153: messageForUnsupportedKeyword caps an oversized key (no-bloat on caller-controlled strings)", async () => {
  const huge = "x".repeat(200);
  const msg = messageForUnsupportedKeyword(huge, "$");
  assert.ok(msg.length < 200, "an oversized key is truncated, not echoed verbatim");
  assert.ok(msg.startsWith("Unsupported JSON Schema keyword \""));
});

// #178: a captatum tool argument misplaced inside the schema gets a "move it out of schema"
// hint (not the generic "remove it") — agents naturally nest budget/timeoutMs/debug there. A
// genuinely-unsupported keyword (format) keeps "remove it". The exact message wording is an
// impl detail that lives HERE (non-frozen), un-frozen from acceptance/153 in #178.
test("#178: messageForUnsupportedKeyword points a misplaced captatum knob out of the schema", async () => {
  const budgetMsg = messageForUnsupportedKeyword("budget", "$");
  assert.ok(budgetMsg.includes("captatum tool argument"), `budget is a captatum arg: ${budgetMsg}`);
  assert.ok(budgetMsg.includes('move it out of "schema"'), `points at the fix: ${budgetMsg}`);
  const timeoutMsg = messageForUnsupportedKeyword("timeoutMs", "$.properties.x");
  assert.ok(timeoutMsg.includes("captatum tool argument"), `timeoutMs is a captatum arg: ${timeoutMsg}`);
  // a genuinely-unsupported keyword (not a captatum arg) keeps the generic "remove it".
  const formatMsg = messageForUnsupportedKeyword("format", "$.properties.email");
  assert.ok(formatMsg.includes("cannot verify it"), `format is not a captatum arg: ${formatMsg}`);
  assert.ok(!formatMsg.includes("captatum tool argument"), "format gets the generic 'remove it' message");
});

// #178 sibling sweep: messageForUnsupportedKeyword is shared with the captatum_bulk path
// (assertExtractSchemaSupported runs for bulk's uniform schema too). The bulk-only top-level
// knobs (urls/maxTransformCostUsd/perSeedTransformCostUsd) must get the SAME "move it out of
// schema" hint — not the generic "remove it" (which would, e.g., silently drop a caller's
// maxTransformCostUsd ceiling). Same defect class as #178; the set is the union of both schemas.
test("#178 sibling: captatum_bulk-only knobs misplaced in a schema also get the 'move it out' hint", async () => {
  for (const key of ["urls", "maxTransformCostUsd", "perSeedTransformCostUsd"]) {
    const msg = messageForUnsupportedKeyword(key, "$");
    assert.ok(msg.includes("captatum tool argument"), `${key} is a captatum_bulk arg: ${msg}`);
    assert.ok(msg.includes('move it out of "schema"'), `${key} points at the fix: ${msg}`);
  }
});

