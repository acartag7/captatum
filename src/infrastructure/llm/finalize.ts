import type { ModelRouterPort } from "../../application/ports/model-router.ts";
import { TransformError, type TransformInput } from "../../application/ports/transformer.ts";
import { findUnsupportedSchemaKeyword, messageForUnsupportedKeyword } from "../../domain/schema-allowlist.ts";
import { parseJsonResult } from "./json-schema-utils.ts";
import { validateJsonSchema } from "./json-schema.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Finalize a provider's raw text into the transform result: trim, run extract JSON parsing +
 * (advisory) schema validation when mode is extract, report the attempt outcome to the router's
 * sticky health, and estimate out-tokens. Pure / side-effectful only through `router.feedback`.
 *
 * The unsupported-keyword fail-closed throw is SYNCHRONOUS (the input-boundary
 * walker runs in this function, before any promise exists) — a pinned contract:
 * callers must not need to await to learn the schema was unusable. The value
 * validation itself is async (pattern execution is worker-bounded) and runs in
 * the returned promise.
 */
export function finalize(
  input: TransformInput,
  text: string,
  model: string,
  router: ModelRouterPort,
  reportedOutTokens?: number,
): Promise<{ result: string; outTokens: number; schemaIssue?: string }> {
  if (input.mode === "extract" && input.schema !== undefined) {
    const finding = findUnsupportedSchemaKeyword(input.schema);
    if (finding?.kind === "unsupported" || finding?.kind === "invalid_pattern") {
      // Same outcome the async path recorded: the attempt burned a provider call
      // on a schema that could never validate.
      router.feedback({ model, outcome: "hard_fail" });
      throw new TransformError(
        "extract_schema_invalid",
        finding.kind === "unsupported"
          ? messageForUnsupportedKeyword(finding.key, finding.path)
          : `${finding.message} — captatum cannot safely execute it; simplify the pattern.`,
      );
    }
  }
  return finalizeValidated(input, text, model, router, reportedOutTokens);
}

async function finalizeValidated(
  input: TransformInput,
  text: string,
  model: string,
  router: ModelRouterPort,
  reportedOutTokens?: number,
): Promise<{ result: string; outTokens: number; schemaIssue?: string }> {
  // Empty-completion handling moved to the model-router retry loop (#48 B): an
  // empty result now retries the next candidate (qwen) with `fallbackFrom`
  // instead of failing here. By this point text is guaranteed non-empty.
  const trimmed = text.trim();
  const extracted = input.mode === "extract"
    ? await finalizeExtract(trimmed, input.schema, model, router)
    : undefined;
  const result = extracted ? extracted.result : trimmed;
  const outTokens = reportedOutTokens ?? estimateTokens(result);
  // The schema-mismatch advisory path (finalizeExtract) already recorded a 'soft' outcome for
  // this model — don't also record 'success' here (one outcome per attempt). The valid-extract
  // and non-extract paths record exactly one 'success'.
  if (!extracted?.schemaIssue) {
    router.feedback({ model, outcome: "success" });
  }
  return { result, outTokens, schemaIssue: extracted?.schemaIssue };
}

async function finalizeExtract(
  text: string,
  schema: unknown,
  model: string,
  router: ModelRouterPort,
): Promise<{ result: string; schemaIssue?: string }> {
  let parsed: unknown;
  try {
    parsed = parseJsonResult(text);
  } catch {
    router.feedback({ model, outcome: "hard_fail" });
    throw new TransformError("extract_invalid_json", "Provider returned invalid JSON for extract output");
  }
  const validation = await validateJsonSchema(parsed, schema);
  const result = JSON.stringify(parsed, null, 2);
  if (!validation.valid) {
    if (validation.unsupported) {
      // Fail closed for keywords this validator cannot check (e.g. format,
      // contentEncoding): we cannot verify them, so reject rather than accept
      // unvalidated structured data. (Contract: extract fails closed for
      // unsupported schema keywords.)
      router.feedback({ model, outcome: "hard_fail" });
      throw new TransformError("extract_schema_invalid", validation.message ?? "Schema uses an unsupported keyword");
    }
    // Advisory: a supported-keyword value mismatch (wrong type, minLength, …) — parseable but
    // non-conforming. Report 'soft' (NOT a hard failure — garbage-ish output can't be reliably
    // told from a legit short answer, so it must not feed demotion). Return the parsed JSON
    // (imperfect structured data > raw fallback) and surface the mismatch as a non-fatal
    // schemaIssue so the caller is informed.
    router.feedback({ model, outcome: "soft" });
    return { result, schemaIssue: validation.message };
  }
  return { result };
}
