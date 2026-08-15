import { deepEqual, finiteNumber, hasDuplicate, invalid, isMultipleOf, isRecord, matchesType, nonNegativeInteger, objectMap, ok, stringArray, stripJsonFence, unsupported, toRegExp, validateEnum, validateSupported, validateType, type SchemaValidationResult } from "./json-schema-utils.ts";
import { validateComposites } from "./json-schema-composites.ts";
import { testPatternsBatched, type PatternTest } from "./bounded-pattern.ts";
import { SUPPORTED_SCHEMA_KEYS, messageForUnsupportedKeyword } from "../../domain/schema-allowlist.ts";

export type { SchemaValidationResult } from "./json-schema-utils.ts";

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

export function parseJsonResult(text: string): unknown {
  const trimmed = stripJsonFence(text.trim());
  return JSON.parse(trimmed) as unknown;
}

/** Two-pass pattern execution (codex r2). Pass 1 (collect): the traversal runs
 *  with `results === undefined`; every pattern encountered is recorded (keyed by
 *  its tree path + pattern source) and treated as matching, so composites
 *  (anyOf/oneOf/not) do not DECIDE on deferred values. All recorded tests then
 *  execute together in ONE bounded worker round-trip — a per-element spawn
 *  would give a 100-element result 100 × the 500 ms budget (codex P1). Pass 2
 *  (check): the identical pure walk re-runs with the results map, so every
 *  pattern — including ones nested inside composite branches — resolves to its
 *  REAL answer exactly where the composite makes its decision. A result missing
 *  from the map (budget exhausted, worker failure) fails CLOSED. */
interface PatternPass {
  /** Pattern encounters, in deterministic walk order (the collect and check
   *  passes replay the identical pure walk, so encounter #N is the same test
   *  in both). */
  tests: PatternTest[];
  /** Check pass only: worker result per encounter index. Absent = fail closed. */
  results?: boolean[];
  /** Encounters so far in this pass (allocate the next test id). */
  cursor: number;
}

export async function validateJsonSchema(value: unknown, schema: unknown): Promise<SchemaValidationResult> {
  if (schema === undefined || schema === true) return ok();
  if (schema === false) return invalid("$ is not allowed by false schema");
  if (!isRecord(schema)) return invalid("schema must be an object or boolean");
  const collect: PatternPass = { tests: [], cursor: 0 };
  // Collect pass — RESULT DISCARDED: with patterns unresolved there is no sound
  // default (deferred-true breaks `not`; deferred-false breaks anyOf), so this
  // walk exists ONLY to gather the pattern tests. The check pass below is the
  // single authority, running every check with real pattern results — semantics
  // identical to the original inline validator.
  await validateAt(value, schema, "$", new Set(), collect);
  if (collect.tests.length === 0) {
    return await validateAt(value, schema, "$", new Set(), { tests: [], results: [], cursor: 0 });
  }
  const batched = await testPatternsBatched(collect.tests);
  if (!batched.ok) {
    return invalid("schema pattern(s) could not be verified within the pattern time budget; pattern not verified");
  }
  const results = batched.matched.map((matched) => matched === true);
  return await validateAt(value, schema, "$", new Set(), { tests: [], results, cursor: 0 });
}

async function validateAt(value: unknown, schema: unknown, path: string, stack: Set<Record<string, unknown>>, pass: PatternPass): Promise<SchemaValidationResult> {
  if (schema === true) return ok();
  if (schema === false) return invalid(`${path} is not allowed by false schema`);
  if (!isRecord(schema)) return invalid(`${path} schema must be an object or boolean`);
  if (stack.has(schema)) return ok();
  stack.add(schema);
  try {
    // Thunks keep the ORIGINAL evaluation order + short-circuit: each step
    // awaits only when reached (an early failure skips later pattern tests).
    const steps: Array<() => SchemaValidationResult | Promise<SchemaValidationResult>> = [
      () => validateSupported(schema, path),
      () => validateComposites(value, schema, path, stack, (v, s, p, st) => validateAt(v, s, p, st, pass), pass.results === undefined),
      () => validateEnum(value, schema, path),
      () => validateType(value, schema, path),
      () => validateString(value, schema, path, pass),
      () => validateNumber(value, schema, path),
      () => validateObject(value, schema, path, stack, pass),
      () => validateArray(value, schema, path, stack, pass),
    ];
    for (const step of steps) {
      const result = await step();
      if (!result.valid) return result;
    }
    return ok();
  } finally {
    stack.delete(schema);
  }
}


async function validateString(value: unknown, schema: Record<string, unknown>, path: string, pass: PatternPass): Promise<SchemaValidationResult> {
  for (const key of ["minLength", "maxLength"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  if ("pattern" in schema && typeof schema.pattern !== "string") {
    return invalid(`${path} schema pattern must be a string`);
  }
  if (typeof value !== "string") return ok();
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    return invalid(`${path} length must be at least ${schema.minLength}`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    return invalid(`${path} length must be at most ${schema.maxLength}`);
  }
  if (typeof schema.pattern === "string") {
    const pattern = toRegExp(schema.pattern, path);
    if (!pattern.valid) return pattern;
    // TRANSFORM-2: a user-supplied pattern must not scan an unbounded value. Rather
    // than silently matching only a prefix (a long value could violate the pattern
    // in its unchecked tail), values past the cap surface as unverified so the
    // caller knows the pattern could not be fully checked (non-fatal advisory).
    const MAX_PATTERN_VALUE_LENGTH = 8192;
    if (value.length > MAX_PATTERN_VALUE_LENGTH) return invalid(`${path} exceeds the 8 KiB pattern-validation cap; pattern not verified`);
    // Pattern matching never runs inline: the input-boundary heuristic is
    // approximate, a passing pattern can still backtrack exponentially, and a
    // synchronous test = an event-loop stall. Collect pass: record the test
    // (id = encounter order). Check pass: resolve the REAL result where the
    // composite decision happens; a missing entry fails CLOSED. The id is an
    // opaque encounter index, NOT a path-derived string — dotted property names
    // collide ($.a.b from "a.b" and from nested a>b) and a colliding key would
    // let a later result overwrite an earlier one (codex P2 r3).
    const id = pass.cursor++;
    if (pass.results === undefined) {
      pass.tests[id] = { source: pattern.value.source, value };
      return ok();
    }
    const matched = pass.results[id];
    if (matched === undefined) {
      return invalid(`${path} could not be verified within the pattern time budget; pattern not verified`);
    }
    if (!matched) return invalid(`${path} must match pattern ${schema.pattern}`);
  }
  return ok();
}

function validateNumber(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  for (const key of ["minimum", "maximum", "multipleOf"] as const) {
    if (key in schema && !finiteNumber(schema[key])) return invalid(`${path} schema ${key} must be a finite number`);
  }
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (key in schema && typeof schema[key] !== "number" && typeof schema[key] !== "boolean") {
      return invalid(`${path} schema ${key} must be a number or boolean`);
    }
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return ok();
  if (typeof schema.minimum === "number" && value < schema.minimum) return invalid(`${path} must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) return invalid(`${path} must be <= ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    return invalid(`${path} must be > ${schema.exclusiveMinimum}`);
  }
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
    return invalid(`${path} must be > ${schema.minimum}`);
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    return invalid(`${path} must be < ${schema.exclusiveMaximum}`);
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
    return invalid(`${path} must be < ${schema.maximum}`);
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
    return invalid(`${path} schema multipleOf must be greater than 0`);
  }
  if (typeof schema.multipleOf === "number" && !isMultipleOf(value, schema.multipleOf)) {
    return invalid(`${path} must be a multiple of ${schema.multipleOf}`);
  }
  return ok();
}

async function validateObject(value: unknown, schema: Record<string, unknown>, path: string, stack: Set<Record<string, unknown>>, pass: PatternPass): Promise<SchemaValidationResult> {
  if (schema.type !== "object" && !isRecord(value)) return ok();
  if (!isRecord(value)) return invalid(`${path} must be object`);
  for (const key of ["minProperties", "maxProperties"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  const count = Object.keys(value).length;
  if (typeof schema.minProperties === "number" && count < schema.minProperties) {
    return invalid(`${path} must have at least ${schema.minProperties} properties`);
  }
  if (typeof schema.maxProperties === "number" && count > schema.maxProperties) {
    return invalid(`${path} must have at most ${schema.maxProperties} properties`);
  }

  if (schema.required !== undefined && !stringArray(schema.required)) {
    return invalid(`${path} schema required must be an array of strings`);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) return invalid(`${path}.${key} is required`);
  }

  const properties = objectMap(schema.properties, "properties", path);
  if (!properties.valid) return properties;
  for (const [key, propertySchema] of Object.entries(properties.value)) {
    if (Object.hasOwn(value, key)) {
      const result = await validateAt(value[key], propertySchema, `${path}.${key}`, stack, pass);
      if (!result.valid) return result;
    }
  }
  return await validateAdditionalProperties(value, schema, properties.value, path, stack, pass);
}

async function validateAdditionalProperties(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  properties: Record<string, unknown>,
  path: string,
  stack: Set<Record<string, unknown>>,
  pass: PatternPass,
): Promise<SchemaValidationResult> {
  const additional = schema.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean" && !isRecord(additional)) {
    return invalid(`${path} schema additionalProperties must be a boolean or schema`);
  }
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an attacker-set
  // own `constructor`/`toString` key would match the inherited property and slip
  // past additionalProperties:false.
  for (const key of Object.keys(value).filter((candidate) => !Object.hasOwn(properties, candidate))) {
    if (additional === false) return invalid(`${path}.${key} is not allowed`);
    if (additional !== undefined && additional !== true) {
      const result = await validateAt(value[key], additional, `${path}.${key}`, stack, pass);
      if (!result.valid) return result;
    }
  }
  return ok();
}

async function validateArray(value: unknown, schema: Record<string, unknown>, path: string, stack: Set<Record<string, unknown>>, pass: PatternPass): Promise<SchemaValidationResult> {
  if (schema.type !== "array" && !Array.isArray(value)) return ok();
  if (!Array.isArray(value)) return invalid(`${path} must be array`);
  for (const key of ["minItems", "maxItems"] as const) {
    const result = nonNegativeInteger(schema, key, path);
    if (!result.valid) return result;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return invalid(`${path} must have at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return invalid(`${path} must have at most ${schema.maxItems} items`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return invalid(`${path} schema uniqueItems must be a boolean`);
  }
  if (schema.uniqueItems === true && hasDuplicate(value)) return invalid(`${path} items must be unique`);
  if (!("items" in schema)) return ok();
  if (Array.isArray(schema.items)) return invalid(`${path} schema items tuple arrays are not supported`);
  for (let index = 0; index < value.length; index += 1) {
    const result = await validateAt(value[index], schema.items, `${path}[${index}]`, stack, pass);
    if (!result.valid) return result;
  }
  return ok();
}
