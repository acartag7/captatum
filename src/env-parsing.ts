/**
 * Strict, fail-closed process-env parsing for operator-facing configuration.
 *
 * Every security-relevant selector follows the same contract the bulk wall-ms
 * knob established (#157): a malformed value is a BOOT FAILURE, never a silent
 * fallback — `value || default` is forbidden on any selector that bounds egress,
 * cost, concurrency, rate, or a sandbox. Trimming happens FIRST (a ConfigMap
 * trailing newline is the #1 real-world contamination and never changes the
 * operator's intent); the SHAPE must then be exactly what the operator typed.
 */
import { BULK_GUARD_CEILINGS } from "./domain/bulk-policy.ts";

export function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}

export function envList(name: string): string[] {
  return envString(name, "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Boolean selector: only the exact trimmed literals "true"/"false" are accepted.
 * Case variants ("TRUE"), a trailing newline on any other spelling, or garbage
 * fail CLOSED at boot instead of silently disabling the protected behavior —
 * an unparseable selector must never widen a sandbox or trust boundary.
 */
export function envStrictBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(
    `${name} must be exactly "true" or "false" (surrounding whitespace tolerated); got: ${JSON.stringify(raw)}`,
  );
}

/**
 * Integer selector: unset/empty/whitespace-only → fallback; otherwise a strict
 * decimal integer in [min, ceiling]. Non-decimal shapes an operator did not
 * literally type — hex, scientific notation, floats, signs, separators — throw,
 * and so does any value above the ceiling: these knobs bound egress
 * concurrency, rate, cost, and browser resources, so widening past the ceiling
 * must be a code change, not a ConfigMap edit. Leading zeros are accepted
 * (still decimal-only, bounded — no security cost).
 */
export function envStrictInteger(name: string, fallback: number, ceiling: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `${name} must be a decimal integer in [${min}, ${ceiling}]; got: ${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed < min || parsed > ceiling) {
    throw new Error(`${name}=${parsed} is outside the allowed range [${min}, ${ceiling}]`);
  }
  return parsed;
}

/**
 * The bulk global-wall selector (#157): a security selector parsed with the
 * strict contract above and the ceiling single-sourced from the domain's hard
 * cap. Kept here so every strict selector lives in one auditable place.
 * (Messages preserved verbatim from the original in config.ts — operators and
 * test/bulk-config-env.test.ts match on them.)
 */
export function envBulkWallMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `${name} must be a decimal integer of milliseconds in [1, ${BULK_GUARD_CEILINGS.maxGlobalWallMs}] ` +
        `(the bulk global-deadline wall ceiling); got: ${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1) {
    throw new Error(`${name} must be >= 1 ms; got: ${JSON.stringify(raw)}`);
  }
  if (parsed > BULK_GUARD_CEILINGS.maxGlobalWallMs) {
    throw new Error(
      `${name}=${parsed} ms exceeds the hard ceiling ${BULK_GUARD_CEILINGS.maxGlobalWallMs} ms ` +
        `(the directed-DoS / egress-deadline bound); lower it toward the 55 s default or up to the ceiling.`,
    );
  }
  return parsed;
}
