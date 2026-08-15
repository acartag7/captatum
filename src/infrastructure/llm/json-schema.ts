import { deepEqual, finiteNumber, hasDuplicate, invalid, isMultipleOf, isRecord, matchesType, nonNegativeInteger, objectMap, ok, stringArray, stripJsonFence, unsupported, toRegExp, validateEnum, validateNumber, validateSupported, validateType, type SchemaValidationResult } from "./json-schema-utils.ts";
import { validateComposites } from "./json-schema-composites.ts";
import { testPatternsBatched, type PatternTest } from "./bounded-pattern.ts";
import { SUPPORTED_SCHEMA_KEYS, messageForUnsupportedKeyword } from "../../domain/schema-allowlist.ts";

export type { SchemaValidationResult } from "./json-schema-utils.ts";

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);


/** Two-pass pattern execution (codex r2-r5). Collect pass: every (schema NODE,
 *  value) pair carrying a pattern is recorded — keyed by node identity + value,
 *  NOT traversal position (the passes short-circuit differently, and positional
 *  ids desynced under that, once producing fail-open acceptance). All tests run
 *  in ONE bounded worker round-trip. Check pass: the identical walk resolves
 *  each pattern at its (node, value) key, so composites decide on REAL results;
 *  a missing entry (budget exhausted / worker failure) fails CLOSED. */
interface PatternPass {
  collecting: boolean;
  tests: PatternTest[];
  /** node -> value -> matched (filled by the check pass; WeakMap keyed by the
   *  schema node object itself, so equal-looking nodes at different tree
   *  positions never share a result). */
  byNode?: WeakMap<object, Map<unknown, boolean>>;
}

export async function validateJsonSchema(value: unknown, schema: unknown): Promise<SchemaValidationResult> {
  if (schema === undefined || schema === true) return ok();
  if (schema === false) return invalid("$ is not allowed by false schema");
  if (!isRecord(schema)) return invalid("schema must be an object or boolean");
  const collect: PatternPass = { collecting: true, tests: [] };
  // Collect pass — RESULT DISCARDED: with patterns unresolved there is no sound
  // default (deferred-true breaks `not`; deferred-false breaks anyOf), so this
  // walk exists ONLY to gather the pattern tests. The check pass below is the
  // single authority, running every check with real pattern results — semantics
  // identical to the original inline validator.
  await validateAt(value, schema, "$", new Set(), collect);
  if (collect.tests.length === 0) {
    return await validateAt(value, schema, "$", new Set(), { collecting: false, tests: [] });
  }
  const batched = await testPatternsBatched(collect.tests);
  if (!batched.ok) {
    return invalid("schema pattern(s) could not be verified within the pattern time budget; pattern not verified");
  }
  const byNode = new WeakMap<object, Map<unknown, boolean>>();
  for (let index = 0; index < collect.tests.length; index += 1) {
    const test = collect.tests[index];
    let values = byNode.get(test.node);
    if (!values) {
      values = new Map();
      byNode.set(test.node, values);
    }
    values.set(test.value, batched.matched[index] === true);
  }
  return await validateAt(value, schema, "$", new Set(), { collecting: false, tests: [], byNode });
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
      () => validateComposites(value, schema, path, stack, (v, s, p, st) => validateAt(v, s, p, st, pass), pass.collecting),
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
    if (pass.collecting) {
      // Record once per (node, value): revisits of the same pair (array items
      // sharing an items-schema, composite branches) reuse the single result.
      let values = pass.byNode?.get(schema);
      if (!values?.has(value)) {
        if (!values) {
          values = new Map();
          pass.byNode ??= new WeakMap();
          pass.byNode.set(schema, values);
        }
        values.set(value, false);
        pass.tests.push({ source: pattern.value.source, value, node: schema });
      }
      return ok();
    }
    const matched = pass.byNode?.get(schema)?.get(value);
    if (matched === undefined) {
      return invalid(`${path} could not be verified within the pattern time budget; pattern not verified`);
    }
    if (!matched) return invalid(`${path} must match pattern ${schema.pattern}`);
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
