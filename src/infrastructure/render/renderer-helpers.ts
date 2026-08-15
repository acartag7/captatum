import type { RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction } from "../../application/ports/renderer.ts";

/** Shared Playwright-renderer helpers (extracted for the 250-line file cap). */

export class RenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

export function rejectFromError(error: unknown): RejectResult {
  if (error instanceof RenderError) {
    return { rejected: true, code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message === "render_timeout") {
    return { rejected: true, code: "timeout", message: "Render timed out" };
  }
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`captatum render error: ${detail}\n`);
  return { rejected: true, code: "render_error", message: `Tier-3 render failed: ${detail}` };
}

export function serviceWorkerAction(): RenderAction {
  return { type: "service-workers-disabled", reason: "context serviceWorkers=block" };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("render_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** A never-resolving promise that rejects with the render-timeout error the moment
 *  `signal` aborts — race it against phases that have no abort wiring of their own
 *  (e.g. the CDP DNS resolution), so a caller's bulk wall deadline still bounds them.
 *  Rejects immediately for an already-aborted signal. */
export function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = (): void => reject(new Error("render_timeout"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function closeQuietly(closeable: { close(): Promise<void> } | undefined): Promise<void> {
  try {
    await closeable?.close();
  } catch {
    /* best-effort cleanup */
  }
}

/** UTF-8-safe truncation: cut at the largest char boundary ≤ maxBytes by walking
 *  back past trailing continuation bytes (0x80–0xBF) so the slice is always valid UTF-8. */
export function capRenderedBytes(content: string, maxBytes: number): { bytes: Uint8Array; truncated: boolean } {
  const full = new TextEncoder().encode(content);
  if (full.byteLength <= maxBytes) return { bytes: full, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (full[cut] & 0xc0) === 0x80) cut -= 1;
  return { bytes: full.subarray(0, cut), truncated: true };
}
