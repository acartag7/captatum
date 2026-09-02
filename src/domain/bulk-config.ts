// Resolution of the effective BulkGuard from operator (deployment) + caller
// (per-call) inputs. Pure domain — split from bulk-policy.ts to respect the
// 250-line limit and to separate "what the caps are + the shaping math"
// (bulk-policy) from "how the effective guard is resolved" (this file). See
// docs/contracts.md §"Tool: captatum_bulk" / BulkGuard.
import type { Output } from "./tier.ts";
import {
  BULK_GUARD_CEILINGS,
  BULK_GUARD_DEFAULTS,
  BULK_RAW_MAX_URLS,
  BULK_SUMMARY_MAX_URLS,
  type BulkGuard,
} from "./bulk-policy.ts";

/** Operator (deployment) knobs — NOT caller-overridable; sourced from config. */
export interface BulkOperatorConfig {
  readonly maxPerHostInflight: number;
  readonly crawlDelayMs: number;
  readonly maxConcurrency: number;
  /** Optional operator override of the global wall. An operator may set the wall anywhere in
   *  [1 ms, BULK_GUARD_CEILINGS.maxGlobalWallMs] — LOWERING below the 55 s hosted default for a
   *  tight deployment, or RAISING toward the 180 s ceiling (e.g. the hosted lever
   *  CAPTATUM_BULK_MAX_GLOBAL_WALL_MS, #157, when a deployment learns its real client timeout is
   *  higher; or the local-binary flavor, which passes the ceiling so it keeps the pre-#148 wall).
   *  Absent → the 55 s hosted default. Never past the ceiling. See resolveBulkGuard below. */
  readonly maxGlobalWallMs?: number;
  /** Optional operator tightening of the per-host directed-DoS COUNT bound (lowering only —
   *  clamped DOWN to the default 10; tightens the quarantine bound for a sensitive deployment). */
  readonly maxPerHostInBulk?: number;
  /** Optional operator tightening of the per-call render-attempt budget (lowering only —
   *  clamped DOWN to the default 10; bounds Tier-3 browser spawns per bulk call). */
  readonly maxRenderedSeeds?: number;
}

/** Caller per-call overrides (founder decision 9): only the cost knobs. Clamped
 *  DOWN to BULK_GUARD_CEILINGS (a caller may cap lower, never raise). */
export interface BulkCallerOverride {
  readonly maxTransformCostUsd?: number;
  readonly perSeedTransformCostUsd?: number;
}

/** Resolve the effective guard: defaults overlaid with operator config, maxUrls
 *  from output, caller cost overrides clamped to ceilings. Returns which knobs
 *  were clamped (for receipt disclosure, decision 10). */
export function resolveBulkGuard(args: {
  operator: Partial<BulkOperatorConfig>;
  output: Output;
  caller?: BulkCallerOverride;
}): { guard: BulkGuard; clamped: string[] } {
  const clamped: string[] = [];
  const op = args.operator;
  const maxTransformCostUsd = clampMax(
    args.caller?.maxTransformCostUsd ?? BULK_GUARD_DEFAULTS.maxTransformCostUsd,
    BULK_GUARD_CEILINGS.maxTransformCostUsd, "maxTransformCostUsd", clamped,
  );
  const maxConcurrency = Math.min(
    BULK_GUARD_DEFAULTS.maxConcurrency, Math.max(1, op.maxConcurrency ?? BULK_GUARD_DEFAULTS.maxConcurrency),
  );
  let perSeedTransformCostUsd = clampMax(
    args.caller?.perSeedTransformCostUsd ?? BULK_GUARD_DEFAULTS.perSeedTransformCostUsd,
    BULK_GUARD_CEILINGS.perSeedTransformCostUsd, "perSeedTransformCostUsd", clamped,
  );
  // The per-seed cap is a SUB-BOUND of the global cap, SIZED FOR CONCURRENCY. Up
  // to maxConcurrency transforms run simultaneously, and each is checked against
  // the global cap only AFTER it settles — so maxConcurrency in-flight transforms
  // could otherwise collectively spend maxConcurrency × perSeed before the
  // post-transform re-check, blowing a caller's lower ceiling (e.g. global=$0.01,
  // perSeed=$0.05, conc=4 → $0.20 spent before re-check). Clamp perSeed to
  // global / maxConcurrency so the first wave can't exceed the caller's ceiling;
  // this also subsumes perSeed ≤ global (conc ≥ 1). Disclosed. (A runtime
  // reservation in the budget tracker, PR 2, can tighten this further.)
  const concurrentSafePerSeed = maxTransformCostUsd / maxConcurrency;
  if (perSeedTransformCostUsd > concurrentSafePerSeed) {
    perSeedTransformCostUsd = concurrentSafePerSeed;
    clamped.push("perSeedTransformCostUsd");
  }
  const maxPerHostInflight = Math.min(
    BULK_GUARD_CEILINGS.maxPerHostInflight,
    Math.max(1, op.maxPerHostInflight ?? BULK_GUARD_DEFAULTS.maxPerHostInflight),
  );
  const crawlDelayMs = Math.max(
    BULK_GUARD_CEILINGS.crawlDelayMsFloor, op.crawlDelayMs ?? BULK_GUARD_DEFAULTS.crawlDelayMs,
  );
  // Operator may set the wall anywhere in [1 ms, CEILING] (#148): the local-binary flavor (no
  // client timeout — a patient stdio client) keeps the pre-#148 180 s wall via an override, and a
  // hosted deployment may raise toward 180 s if it learns its real client timeout is higher. Absent
  // → the 55 s hosted DEFAULT (the orphaning-prevention value for claude.ai/chatgpt.com/Claude Code).
  const maxGlobalWallMs = op.maxGlobalWallMs !== undefined
    ? Math.min(BULK_GUARD_CEILINGS.maxGlobalWallMs, Math.max(1, op.maxGlobalWallMs))
    : BULK_GUARD_DEFAULTS.maxGlobalWallMs;
  // Operator may TIGHTEN the per-host directed-DoS count bound (lowering only, min 1).
  const maxPerHostInBulk = op.maxPerHostInBulk !== undefined
    ? Math.min(BULK_GUARD_DEFAULTS.maxPerHostInBulk, Math.max(1, op.maxPerHostInBulk))
    : BULK_GUARD_DEFAULTS.maxPerHostInBulk;
  // Operator may TIGHTEN the per-call render-attempt budget (lowering only, min 0).
  const maxRenderedSeeds = op.maxRenderedSeeds !== undefined
    ? Math.min(BULK_GUARD_DEFAULTS.maxRenderedSeeds, Math.max(0, op.maxRenderedSeeds))
    : BULK_GUARD_DEFAULTS.maxRenderedSeeds;
  return {
    guard: {
      maxUrls: args.output === "raw" ? BULK_RAW_MAX_URLS : BULK_SUMMARY_MAX_URLS,
      maxPerHostInBulk,
      maxGlobalEgressBytes: BULK_GUARD_DEFAULTS.maxGlobalEgressBytes,
      maxGlobalWallMs,
      maxConcurrency,
      maxRenderedSeeds,
      maxPerHostInflight,
      crawlDelayMs,
      maxTransformCostUsd,
      perSeedTransformCostUsd,
    },
    clamped,
  };
}

function clampMax(value: number, ceiling: number, name: string, clamped: string[]): number {
  if (value > ceiling) {
    clamped.push(name);
    return ceiling;
  }
  return value;
}
