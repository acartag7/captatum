import { Worker } from "node:worker_threads";

/**
 * Time-bounded RegExp testing for caller-supplied schema `pattern`s — BATCHED:
 * one worker, one round-trip, one wall-clock budget for the ENTIRE validation
 * pass. A pattern that passes the input-boundary heuristic can still backtrack
 * catastrophically (the heuristic compares raw branch text; length-differing
 * semantically-overlapping branches like (\s|\x20)+ evade it — measured 9.2 s
 * on a 28-char value), and a synchronous regex stalls the whole event loop.
 *
 * The batch exists so a valid many-element result (an array whose items carry a
 * pattern) costs ONE spawn with ONE shared deadline, not one spawn + one fresh
 * 500 ms budget per element (codex P1: 100 elements ≈ 5.7 s and unbounded
 * linear growth). On timeout or any worker failure every unproven pattern is
 * FAIL-CLOSED (not verified → invalid), never a hang and never a silent pass.
 */
export const PATTERN_TEST_BUDGET_MS = 500;

export interface PatternTest {
  source: string;
  value: string;
}

// ESM-safe on every Node 24.x: an `eval: true` worker's module type follows the
// ambient package type on some builds (24.15 treats it as ESM, where a top-level
// `require` throws before any test runs — codex P1), so the source uses a
// dynamic import inside an async IIFE, which is valid in BOTH module types.
const WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  const results = [];
  for (const test of workerData.tests) {
    try {
      results.push(new RegExp(test.source).test(test.value));
    } catch {
      results.push("failed");
    }
  }
  parentPort.postMessage(results);
})();
`;

export type BatchedResult =
  | { ok: true; matched: boolean[] }
  | { ok: false; timedOut: boolean };

export async function testPatternsBatched(
  tests: PatternTest[],
  budgetMs: number = PATTERN_TEST_BUDGET_MS,
): Promise<BatchedResult> {
  if (tests.length === 0) return { ok: true, matched: [] };
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BatchedResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { tests } });
    } catch {
      resolve({ ok: false, timedOut: false });
      return;
    }
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), budgetMs);
    worker.on("message", (matched: unknown) => {
      finish({
        ok: true,
        matched: Array.isArray(matched) ? matched.map((m) => m === true) : [],
      });
    });
    worker.on("error", () => finish({ ok: false, timedOut: false }));
    worker.on("exit", () => finish({ ok: false, timedOut: false }));
  });
}
