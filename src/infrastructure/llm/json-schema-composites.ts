import { invalid, ok, schemaList, type SchemaValidationResult } from "./json-schema-utils.ts";

/**
 * `validateAt` is passed in (rather than imported) so this module stays a leaf —
 * no circular dependency back into json-schema.ts.
 */
type Recurse = (
  value: unknown,
  schema: unknown,
  path: string,
  stack: Set<Record<string, unknown>>,
) => Promise<SchemaValidationResult>;

/** During the COLLECT pass (patterns deferred, treated as matching) composite
 *  outcomes are provisional — `not:{pattern}` "fails", oneOf "counts wrong" —
 *  so acting on them would stop collection before later patterns and desync
 *  the two passes (codex P2 r4: `{not:{pattern:"^a$"},pattern:"^b$"}` on "b"
 *  skipped the outer pattern, and the check pass then failed it as uncollected).
 *  In collect mode every composite short-circuit is suppressed: the walk keeps
 *  descending, the result is discarded by the caller anyway. */


/**
 * Evaluate allOf / anyOf / oneOf / not. An unsupported keyword found inside any
 * branch is propagated unchanged so the caller fails closed (it cannot be
 * verified) rather than collapsing the composite down to a boolean and dropping
 * the unsupported signal.
 */
export async function validateComposites(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  stack: Set<Record<string, unknown>>,
  recurse: Recurse,
  collect = false,
): Promise<SchemaValidationResult> {
  const allOf = schemaList(schema.allOf, "allOf", path);
  if (!allOf.valid) return allOf;
  for (const subschema of allOf.value) {
    const result = await recurse(value, subschema, path, stack);
    if (!result.valid && !collect) return result;
  }

  const anyOf = schemaList(schema.anyOf, "anyOf", path);
  if (!anyOf.valid) return anyOf;
  if (anyOf.value.length > 0) {
    const result = await disjunction(value, anyOf.value, path, stack, recurse, false, collect);
    if (!result.valid && !collect) return result;
  }

  const oneOf = schemaList(schema.oneOf, "oneOf", path);
  if (!oneOf.valid) return oneOf;
  if (oneOf.value.length > 0) {
    const result = await disjunction(value, oneOf.value, path, stack, recurse, true, collect);
    if (!result.valid && !collect) return result;
  }

  if ("not" in schema) {
    const result = await recurse(value, schema.not, path, stack);
    if (result.unsupported) return result;
    if (result.valid && !collect) return invalid(`${path} must not match not schema`);
  }
  return ok();
}

/** Shared anyOf (exactOne=false) / oneOf (exactOne=true) evaluation. */
async function disjunction(
  value: unknown,
  choices: unknown[],
  path: string,
  stack: Set<Record<string, unknown>>,
  recurse: Recurse,
  exactOne: boolean,
  collect = false,
): Promise<SchemaValidationResult> {
  let matches = 0;
  for (const choice of choices) {
    const result = await recurse(value, choice, path, stack);
    if (result.unsupported) return result;
    if (result.valid) matches += 1;
  }
  const failed = (exactOne ? matches !== 1 : matches === 0) && !collect;
  return failed
    ? invalid(exactOne
      ? `${path} must match exactly one oneOf schema`
      : `${path} must match at least one anyOf schema`)
    : ok();
}
