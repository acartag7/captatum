import { z } from "zod";
import type { ProvenanceError } from "../../domain/result.ts";
import type { Output } from "../../domain/tier.ts";
import type { TransformOverride } from "../ports/transformer.ts";
import { findUnsupportedSchemaKeyword, MAX_SCHEMA_DEPTH, messageForUnsupportedKeyword } from "../../domain/schema-allowlist.ts";
import { recoverExtractSchemaKnobs, type ExtractSchemaKnobInput } from "./schema-knob-recovery.ts";

const CRLF = /[\r\n]|%0d|%0a/i;
const DEFAULT_PROMPT = "Provide a concise summary of the page.";

const positiveInteger = z.number().int().positive();
/** Shared transform-override shape (exported so captatum_bulk mirrors it exactly). */
export const transformOverrideSchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
}).catchall(z.unknown());

const captatumInputSchema = z.object({
  url: z.string().min(1),
  prompt: z.string().optional(),
  output: z.enum(["summary", "raw", "extract"]).optional(),
  schema: z.unknown().optional(),
  budget: positiveInteger.optional(),
  transform: transformOverrideSchema.optional(),
  maxBytes: positiveInteger.optional(),
  timeoutMs: positiveInteger.optional(),
  allowRender: z.boolean().optional(),
  debug: z.boolean().optional(),
}).strict();

export interface CaptatumDefaults {
  maxBytes: number;
  maxBytesHardCap: number;
  timeoutMs: number;
  timeoutMsHardCap: number;
  renderTimeoutMs: number;
  renderTimeoutMsHardCap: number;
  maxHops: number;
  allowRender: boolean;
  prompt: string;
  /** Output used when the caller omits `output`. "raw" by default so a fetcher with
   *  no transform provider returns full raw content, not a silent truncated excerpt;
   *  the use case raises this to "summary" when a provider is configured. */
  defaultOutput: Output;
}

export const DEFAULT_CAPTATUM_DEFAULTS: CaptatumDefaults = {
  maxBytes: 5 * 1024 * 1024,
  maxBytesHardCap: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  timeoutMsHardCap: 60_000,
  renderTimeoutMs: 20_000,
  renderTimeoutMsHardCap: 60_000,
  maxHops: 5,
  allowRender: true,
  prompt: DEFAULT_PROMPT,
  defaultOutput: "raw",
};

export interface CaptatumInput {
  url: string;
  prompt?: string;
  output?: Output;
  schema?: unknown;
  budget?: number;
  transform?: TransformOverride;
  maxBytes?: number;
  timeoutMs?: number;
  allowRender?: boolean;
  debug?: boolean;
}

export interface NormalizedCaptatumInput {
  url: string;
  prompt: string;
  requestedOutput: Output;
  schema?: unknown;
  budget?: number;
  transform?: TransformOverride;
  maxBytes: number;
  timeoutMs: number;
  renderTimeoutMs: number;
  maxHops: number;
  allowRender: boolean;
  /** Presentation-only flag: unlock heavy diagnostic fields in the MCP payload. */
  debug: boolean;
  schemaKnobWarnings: ProvenanceError[];
}

export interface ContractErrorBody {
  error: { code: string; message: string };
}

export class CaptatumInputError extends Error {
  readonly body: ContractErrorBody;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaptatumInputError";
    this.body = { error: { code, message } };
  }
}

/**
 * Fail-closed at the input boundary (#153): for `output:"extract"` with a caller schema, reject
 * BEFORE any fetch/LLM if the schema uses an unsupported keyword (the validator is an allowlist of
 * supported keywords, not a blocklist) or nests beyond the cap. The schema is untrusted DATA: only
 * the (capped) key name + a captatum-constructed path enter the message; no schema value is echoed.
 * Shared by `normalizeCaptatumInput` and `normalizeBulkInput` (bulk's uniform schema).
 */
export function assertExtractSchemaSupported(output: unknown, schema: unknown): void {
  if (output !== "extract" || schema === undefined) return;
  const finding = findUnsupportedSchemaKeyword(schema);
  if (!finding) return;
  if (finding.kind === "too_deep") {
    throw new CaptatumInputError(
      "extract_schema_too_deep",
      `JSON Schema nesting exceeds the supported depth (>${MAX_SCHEMA_DEPTH}); simplify it.`,
    );
  }
  if (finding.kind === "tuple_items") {
    throw new CaptatumInputError(
      "extract_schema_tuple_unsupported",
      `Tuple-form "items" (arrays) are not supported at ${finding.path} — captatum cannot verify tuple validation; use a single schema (items: {…}).`,
    );
  }
  if (finding.kind === "invalid_pattern") {
    throw new CaptatumInputError(
      "extract_schema_invalid_pattern",
      `${finding.message} — captatum cannot safely execute it; simplify the pattern.`,
    );
  }
  throw new CaptatumInputError("extract_schema_unsupported_keyword", messageForUnsupportedKeyword(finding.key, finding.path));
}

export function normalizeCaptatumInput(
  value: unknown,
  defaults: CaptatumDefaults = DEFAULT_CAPTATUM_DEFAULTS,
): NormalizedCaptatumInput {
  const parsed = parseInput(value);
  const recovered = recoverExtractSchemaKnobs(parsed, isValidExtractSchemaKnob);
  // Fail fast at the INPUT boundary (#153): an extract schema using an unsupported keyword
  // (or nesting beyond the cap) cannot be verified, so reject before any fetch/LLM rather than
  // degrading post-transform. Shared with captatum_bulk's uniform schema (assertExtractSchemaSupported).
  assertExtractSchemaSupported(parsed.output, recovered.schema);
  const effective = { ...parsed, ...recovered.recovered };
  const url = normalizeContractUrl(effective.url);
  return {
    url,
    prompt: effective.prompt ?? defaults.prompt,
    requestedOutput: effective.output ?? defaults.defaultOutput,
    schema: recovered.schema,
    budget: effective.budget,
    transform: effective.transform as TransformOverride | undefined,
    maxBytes: Math.min(effective.maxBytes ?? defaults.maxBytes, defaults.maxBytesHardCap),
    timeoutMs: Math.min(effective.timeoutMs ?? defaults.timeoutMs, defaults.timeoutMsHardCap),
    renderTimeoutMs: Math.min(effective.timeoutMs ?? defaults.renderTimeoutMs, defaults.renderTimeoutMsHardCap),
    maxHops: defaults.maxHops,
    allowRender: effective.allowRender ?? defaults.allowRender,
    debug: effective.debug ?? false,
    schemaKnobWarnings: recovered.warnings,
  };
}

export function isValidExtractSchemaKnob(
  key: keyof Pick<ExtractSchemaKnobInput, "budget" | "timeoutMs" | "allowRender" | "debug" | "maxBytes" | "transform">,
  value: unknown,
): boolean {
  return value !== undefined && captatumInputSchema.shape[key].safeParse(value).success;
}

function parseInput(value: unknown): CaptatumInput {
  const result = captatumInputSchema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  if (first?.path[0] === "url") {
    throw new CaptatumInputError("invalid_url", "URL is required");
  }
  throw new CaptatumInputError("invalid_input", "captatum input is invalid");
}

/** Exported for captatum_bulk's per-entry URL validation (same scheme upgrade,
 *  userinfo/CRLF strip, http→https). Throws CaptatumInputError on a bad URL. */
export function normalizeContractUrl(input: string): string {
  if (CRLF.test(input)) {
    throw new CaptatumInputError("crlf_url", "URL contains a forbidden CRLF sequence");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new CaptatumInputError("invalid_url", "URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CaptatumInputError("unsupported_scheme", "Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new CaptatumInputError("userinfo_url", "URLs with userinfo are not allowed");
  }
  if (!parsed.hostname) {
    throw new CaptatumInputError("invalid_url", "URL must include a hostname");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.href;
}
