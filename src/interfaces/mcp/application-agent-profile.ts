import type { Result } from "../../domain/result.ts";

const SAFE_MCP_TITLE_CODE_POINT =
  /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u;

/** The frozen consumer profile is selected by the successful wire shape. */
export function isApplicationAgentProfile(
  result: Result,
  debug: boolean,
): boolean {
  return result.output === "extract" && !debug;
}

/** Canonical one-line title shared by every MCP presentation channel. */
export function canonicalMcpTitle(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const allowed: string[] = [];
  let truncated = false;
  for (const codePoint of value) {
    if (!SAFE_MCP_TITLE_CODE_POINT.test(codePoint)) continue;
    if (allowed.length === 140) {
      truncated = true;
      break;
    }
    allowed.push(codePoint);
  }
  if (allowed.length === 0) return undefined;
  return truncated
    ? `${allowed.slice(0, 139).join("").trimEnd()}…`
    : allowed.join("");
}
