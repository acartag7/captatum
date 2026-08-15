export interface SchemaValidationResult {
  valid: boolean;
  message?: string;
  /**
   * Set when validation failed because the schema used a keyword this validator
   * does not support (and therefore cannot check). Callers distinguish this from
   * a supported-keyword value mismatch: an unsupported keyword cannot be
   * verified, so the safe behavior is to fail closed rather than accept
   * unvalidated structured data.
   */
  unsupported?: boolean;
}

export function schemaList(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: unknown[] } {
  if (value === undefined) return { valid: true, value: [] };
  return Array.isArray(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an array`, value: [] };
}

export function objectMap(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: Record<string, unknown> } {
  if (value === undefined) return { valid: true, value: {} };
  return isRecord(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an object`, value: {} };
}

export function nonNegativeInteger(
  schema: Record<string, unknown>,
  key: string,
  path: string,
): SchemaValidationResult {
  if (!(key in schema)) return ok();
  return Number.isInteger(schema[key]) && Number(schema[key]) >= 0
    ? ok()
    : invalid(`${path} schema ${key} must be a non-negative integer`);
}

// Pattern policy (length cap + catastrophic-shape heuristic + compile) lives in
// domain/schema-pattern.ts so the INPUT boundary and this validator share one
// source of truth. Re-exported here for existing importers.
export { toRegExp, MAX_PATTERN_LENGTH } from "../../domain/schema-pattern.ts";
import { SUPPORTED_SCHEMA_KEYS, messageForUnsupportedKeyword } from "../../domain/schema-allowlist.ts";
export function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

export function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ok(): SchemaValidationResult {
  return { valid: true };
}

export function invalid(message: string): SchemaValidationResult {
  return { valid: false, message };
}

export function unsupported(message: string): SchemaValidationResult {
  return { valid: false, message, unsupported: true };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Deterministic JSON so two objects equal up to key order compare equal —
 * uniqueItems/enum/const must treat {a:1,b:2} and {b:2,a:1} as the same value,
 * and JSON.stringify preserves insertion order (so it would not). Recursively
 * sorts object keys; arrays preserve order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hasDuplicate(values: unknown[]): boolean {
  return values.some((value, index) => values.findIndex((other) => deepEqual(value, other)) !== index);
}

export function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 100;
}

export function validateSupported(schema: Record<string, unknown>, path: string): SchemaValidationResult {
  const unsupportedKey = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYS.has(key));
  return unsupportedKey ? unsupported(messageForUnsupportedKeyword(unsupportedKey, path)) : ok();
}

export function validateEnum(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if ("const" in schema && !deepEqual(value, schema.const)) return invalid(`${path} must equal schema const`);
  if (!("enum" in schema)) return ok();
  if (!Array.isArray(schema.enum)) return invalid(`${path} schema enum must be an array`);
  return schema.enum.some((candidate) => deepEqual(value, candidate))
    ? ok()
    : invalid(`${path} must be one of schema enum values`);
}

export function validateType(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
  if (!("type" in schema)) return ok();
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.every((type) => typeof type === "string" && JSON_TYPES.has(type))) {
    return invalid(`${path} schema type must be a JSON Schema type`);
  }
  return types.some((type) => matchesType(value, String(type)))
    ? ok()
    : invalid(`${path} must be ${types.join(" or ")}`);
}

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

export function parseJsonResult(text: string): unknown {
  const trimmed = stripJsonFence(text.trim());
  return JSON.parse(trimmed) as unknown;
}

export function validateNumber(value: unknown, schema: Record<string, unknown>, path: string): SchemaValidationResult {
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
