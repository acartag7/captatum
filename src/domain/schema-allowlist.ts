// Shared JSON-Schema keyword policy for the `output:"extract"` input boundary (#153).
//
// The caller-supplied extract schema is UNTRUSTED INPUT. Two layers must agree on exactly
// which JSON Schema keywords captatum can verify:
//   - the value validator (infrastructure/llm/json-schema.ts, runs post-fetch on the LLM output)
//   - the input-boundary fail-fast (application/use-cases/captatum-input.ts + bulk-input.ts,
//     runs BEFORE any fetch/LLM)
// So the supported-keyword set + the pure walker live here in domain — importable by both the
// application and infrastructure layers (application must not import infrastructure concretes).
// Treat the schema as DATA: only the (length-capped) key name + a captatum-constructed path
// ever enter an error message; no schema value is echoed.

/** Every JSON Schema keyword this tool's value validator can enforce. A schema using a keyword
 *  NOT in this set cannot be verified, so it fails closed — at the input boundary (before any
 *  fetch/LLM) and, defense-in-depth, at the transform seam. This is the single source of truth;
 *  json-schema.ts imports it rather than redeclaring. */
import { toRegExp } from "./schema-pattern.ts";

export const SUPPORTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "$comment", "$defs", "$id", "$schema", "additionalProperties", "allOf", "anyOf", "const",
  "default", "deprecated", "description", "enum", "examples", "exclusiveMaximum",
  "exclusiveMinimum", "items", "maxItems", "maxLength", "maxProperties", "maximum",
  "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not", "oneOf",
  "pattern", "properties", "readOnly", "required", "title", "type", "uniqueItems",
  "writeOnly", "definitions",
]);

/** Max supported schema nesting depth (#153). Far above any legitimate schema (~20 levels of
 *  pure schema nesting) and far below V8's ~10K-frame stack. The input-boundary walker runs
 *  PRE-FETCH on untrusted input — free to attack, unlike the post-fetch value validator — so it
 *  carries an explicit cap (request-body SIZE bounds total nodes, not nesting DEPTH; a <1 MB
 *  body of nested objects reaches ~150K depth). The cap is also the chokepoint: a deep schema
 *  is rejected at input, so the value validator is protected for every captatum/bulk path. */
export const MAX_SCHEMA_DEPTH = 64;

export type SchemaKeywordFinding =
  | { kind: "unsupported"; key: string; path: string }
  | { kind: "too_deep"; path: string }
  | { kind: "tuple_items"; path: string }
  | { kind: "invalid_pattern"; path: string; message: string };

/** Length-cap an untrusted caller string (an offending keyword or a property name) before it
 *  enters an error message — a hostile multi-KB value must not bloat the JSON-RPC error /
 *  receipt. Applies to BOTH caller-controlled strings echoed (the key AND the property-name
 *  path segment), per the no-bloat principle. */
const MAX_ECHO = 80;
function capEcho(value: string): string {
  return value.length <= MAX_ECHO ? value : `${value.slice(0, MAX_ECHO - 1)}…`;
}

/** Captatum top-level tool arguments an agent may mistakenly nest inside an extract
 *  `schema` (they read like JSON-Schema-shaped names but are captatum knobs). When one
 *  appears as a schema key, the error points at the real fix (move it to the top level)
 *  instead of the generic "remove it" — agents naturally pass budget/timeoutMs/debug (and,
 *  for captatum_bulk, maxTransformCostUsd/perSeedTransformCostUsd/urls) into the schema,
 *  and "remove it" is wrong advice for a real captatum arg. Union of captatum-input.ts's
 *  and bulk-input.ts's zod schemas — keep in sync when a top-level arg is added/removed in
 *  EITHER (messageForUnsupportedKeyword is shared by both paths via assertExtractSchemaSupported).
 *  Key names are matched case-sensitively (captatum args are lowercase); no schema value
 *  is ever echoed. */
const CAPTATUM_KNOB_KEYS: ReadonlySet<string> = new Set([
  "url", "urls", "prompt", "output", "schema", "budget", "transform", "maxBytes", "timeoutMs", "allowRender", "debug", "maxTransformCostUsd", "perSeedTransformCostUsd",
]);

/** Compose the unsupported-keyword message. A captatum tool argument misplaced inside the
 *  schema (budget/timeoutMs/debug/…) gets a "move it out of schema" hint; any other
 *  unsupported keyword (format, contentEncoding, …) gets the generic "remove it". It leads
 *  with the offending key (the pre-fix `${path} schema keyword "${key}"` visually merged `$`
 *  + `schema` into `$schema`, implicating the supported `$schema` key) and keeps the path
 *  visually separate. */
export function messageForUnsupportedKeyword(key: string, path: string): string {
  const cleanKey = capEcho(key);
  if (CAPTATUM_KNOB_KEYS.has(cleanKey)) {
    return `"${cleanKey}" at ${path} is a captatum tool argument, not a JSON Schema keyword — move it out of "schema" to the top level of the captatum call (captatum validates "schema" as a JSON Schema, so a knob nested there is rejected).`;
  }
  return `Unsupported JSON Schema keyword "${cleanKey}" at ${path} — captatum cannot verify it; remove it.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walk a caller-supplied extract schema and return the first unsupported keyword
 * (with its path), a too-deep signal, or a tuple-form-`items` signal — or `undefined` when the
 * schema is fully supported. Pure + value-free. The recursion set mirrors the applied-subschema
 * locations the value validator (`validateAt`) visits — `properties.*`, `items` (single-schema
 * form only; tuple arrays are flagged as `{kind:"tuple_items"}` since the value validator only
 * advisories them), `additionalProperties` (when it is a schema), `allOf`/`anyOf`/`oneOf` (each
 * element), `not`.
 * It does NOT visit `$defs`/`definitions`: those are reference containers never applied to the
 * value (captatum has no `$ref` support), so visiting them would over-reject schemas the value
 * validator accepts. Per-node key order matches `Object.keys` (same as the value validator's
 * `validateSupported`), so the first offending keyword found agrees with it on any shared schema.
 * Fails closed (`kind:"too_deep"`) on nesting beyond `MAX_SCHEMA_DEPTH`. An object-identity
 * `seen` Set guards cycles (JSON.parse cannot cycle; cheap defense).
 */
export function findUnsupportedSchemaKeyword(schema: unknown): SchemaKeywordFinding | undefined {
  return walk(schema, "$", 0, new Set());
}

function walk(
  schema: unknown,
  path: string,
  depth: number,
  seen: Set<Record<string, unknown>>,
): SchemaKeywordFinding | undefined {
  if (!isRecord(schema)) return undefined; // boolean schemas (true/false) + non-records carry no keys
  if (depth > MAX_SCHEMA_DEPTH) return { kind: "too_deep", path };
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) return { kind: "unsupported", key, path };
  }
  // `pattern` is an allowed KEY whose VALUE compiles to a RegExp captatum will
  // EXECUTE — validate its content HERE (pre-fetch) so an oversized, invalid, or
  // heuristic-flagged pattern is rejected before any egress/LLM spend, not at
  // finalize after the bill (the two layers share domain/schema-pattern.ts).
  // The toRegExp messages carry the path only — no schema value is echoed.
  if (typeof schema.pattern === "string") {
    const compiled = toRegExp(schema.pattern, path);
    if (!compiled.valid) return { kind: "invalid_pattern", path, message: compiled.message };
  } else if ("pattern" in schema) {
    return { kind: "invalid_pattern", path, message: `${path} schema pattern must be a string` };
  }
  // Tuple-form items (an array) is an unverifiable form: the value validator only advisories it
  // (invalid, not unsupported), so fail closed at the input boundary like an unsupported keyword.
  if (Array.isArray(schema.items)) return { kind: "tuple_items", path: `${path}.items` };
  for (const [child, childPath] of children(schema, path)) {
    const found = walk(child, childPath, depth + 1, seen);
    if (found) return found;
  }
  return undefined;
}

/** The applied-subschema locations (mirror `validateAt`). Property-name path segments are
 *  caller-controlled, so they are capped (no-bloat on both echoed strings). */
function children(node: Record<string, unknown>, path: string): Array<[unknown, string]> {
  const out: Array<[unknown, string]> = [];
  if (isRecord(node.properties)) {
    for (const [k, v] of Object.entries(node.properties)) {
      out.push([v, `${path}.properties.${capEcho(k)}`]);
    }
  }
  if (isRecord(node.items)) out.push([node.items, `${path}.items`]);
  if (isRecord(node.additionalProperties)) out.push([node.additionalProperties, `${path}.additionalProperties`]);
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const arr = node[key];
    if (Array.isArray(arr)) arr.forEach((v, i) => out.push([v, `${path}.${key}[${i}]`]));
  }
  if (isRecord(node.not)) out.push([node.not, `${path}.not`]);
  return out;
}
