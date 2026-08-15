import { Worker } from "node:worker_threads";

/**
 * Time-bounded RegExp.test for caller-supplied schema `pattern`s. A pattern that
 * passes the input-boundary heuristic can still backtrack catastrophically —
 * the heuristic compares raw branch text, and length-differing semantically
 * overlapping branches ((\s|\x20)+, (\d|[0-9][0-9])+) evade it (executed PoC
 * 2026-08-15: 9.2 s on a 28-char value, clean 2^n doubling; the 8 KiB value cap
 * bounds input LENGTH, not match TIME, and the synchronous regex stalls the
 * whole event loop — the admission cap cannot help). The match therefore runs
 * on a worker thread under a wall-clock budget; on timeout or any worker
 * failure the answer is FAIL-CLOSED (treat as not-verifiable → invalid), never
 * a hang and never a silent pass.
 */
export const PATTERN_TEST_BUDGET_MS = 500;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const re = new RegExp(workerData.source);
  parentPort.postMessage({ matched: re.test(workerData.value) });
} catch {
  parentPort.postMessage({ failed: true });
}
`;

export type BoundedTestResult =
  | { ok: true; matched: boolean }
  | { ok: false; timedOut: boolean };

export async function testPatternBounded(
  pattern: RegExp,
  value: string,
  budgetMs: number = PATTERN_TEST_BUDGET_MS,
): Promise<BoundedTestResult> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source: pattern.source, value } });
    } catch {
      // Compilation was already validated upstream; a spawn failure is fail-closed.
      resolve({ ok: false, timedOut: false });
      return;
    }
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), budgetMs);
    worker.on("message", (message: { matched?: unknown; failed?: unknown }) => {
      if ("failed" in message) finish({ ok: false, timedOut: false });
      else finish({ ok: true, matched: message.matched === true });
    });
    worker.on("error", () => finish({ ok: false, timedOut: false }));
    worker.on("exit", () => finish({ ok: false, timedOut: false }));
  });
}
