import type { Result } from "../../domain/result.ts";

/** The frozen consumer profile is selected by the successful wire shape. */
export function isApplicationAgentProfile(
  result: Result,
  debug: boolean,
): boolean {
  return result.output === "extract" && !debug;
}

/** Canonical one-line title shared by the profile's text and JSON channels. */
export function canonicalApplicationAgentTitle(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\x00-\x1f\x7f​-‏‪-‮]/g, "");
  const clipped = sanitized.length <= 140
    ? sanitized
    : `${sanitized.slice(0, 139).trimEnd()}…`;
  return clipped === "" ? undefined : clipped;
}
