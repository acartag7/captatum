import type { RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderFailure, RenderInput, RenderOutput } from "../../application/ports/renderer.ts";
import type { ProvenanceError } from "../../domain/result.ts";
import type { RenderRouteState } from "./route-state.ts";
import { streamFromBytes } from "../http/body.ts";
import { safeRenderUrl } from "./browser-url-guard.ts";

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

export function blockDownload(download: { url(): string; cancel?(): Promise<void> }, actions: RenderAction[]): void {
  actions.push({ type: "download-blocked", reason: "downloads disabled", url: safeRenderUrl(download.url()) });
  void download.cancel?.();
}

export function closeLegacyWebSocket(socket: { url(): string; close?(): Promise<void> }, actions: RenderAction[]): void {
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  void socket.close?.();
}

export async function closeWebSocket(socket: { url(): string; close(): Promise<void> }, actions: RenderAction[]): Promise<void> {
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  await socket.close();
}

export function closePopup(popup: { url(): string; close(): Promise<void> }, actions: RenderAction[]): void {
  actions.push({ type: "popup-closed", reason: "popups disabled", url: safeRenderUrl(popup.url()) });
  void popup.close().catch(() => {});
}

export function renderSuccess(input: RenderInput, pageUrl: string, status: number, bytes: Uint8Array, state: RenderRouteState, notice: ProvenanceError | undefined, domTextLength: number | undefined): RenderOutput {
  const egressHosts = state.egressHosts();
  return {
    rendered: true,
    fetchResult: {
      status,
      finalUrl: state.finalUrl || safeRenderUrl(pageUrl) || input.url,
      redirects: state.redirects,
      bodyStream: streamFromBytes(bytes),
      contentType: "text/html; charset=utf-8",
      bytes: bytes.byteLength,
    },
    actions: state.actions,
    egressBytes: state.egressBytes(),
    ...(egressHosts.length > 0 ? { egressHosts } : {}),
    ...(domTextLength !== undefined ? { domTextLength } : {}),
    ...(notice ? { notice } : {}),
  };
}

export function renderFailure(rejected: RejectResult, actions: RenderAction[], state: RenderRouteState): RenderFailure {
  // A failed render may have fulfilled subresources before failing — carry the partial egress (codex R2 P2).
  const egressHosts = state.egressHosts();
  return { ...rejected, rendered: false, actions, egressBytes: state.egressBytes(), ...(egressHosts.length ? { egressHosts } : {}) };
}
