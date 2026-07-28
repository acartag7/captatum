import type { RejectResult } from "../../application/ports/fetcher.ts";
import type { ProvenanceError } from "../../domain/result.ts";
import type {
  RenderAction,
  RenderFailure,
  RenderInput,
  RenderOutput,
  RenderPort,
} from "../../application/ports/renderer.ts";
import { parseCdpEndpoint } from "../../config.ts";
import { streamFromBytes } from "../http/body.ts";
import { P1BrowserUrlGuard, safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { RenderRouteState } from "./route-state.ts";
import { liveDomTextLength, waitForBodyStable } from "./settle.ts";
import type {
  PlaywrightBrowser,
  PlaywrightDownload,
  PlaywrightContext,
  PlaywrightEventValue,
  PlaywrightModule,
  PlaywrightPage,
  PlaywrightWebSocket,
  PlaywrightWebSocketRoute,
} from "./playwright-types.ts";

export interface PlaywrightRendererDeps {
  loadPlaywright?: () => Promise<PlaywrightModule>;
  guard?: BrowserUrlGuard;
  /** CDP endpoint for sidecar mode (e.g. "http://localhost:9222"). If set, the renderer connects to a long-lived Chromium in its own container instead of launching one in-process. */
  cdpEndpoint?: string;
  /** Chromium OS sandbox for in-process launch. Default true — the threat model mandates sandbox on; --no-sandbox in-process is only for a sidecar-less transitional deploy. */
  chromiumSandbox?: boolean;
  /** Post-load settle: networkidle cap, content-stability min dwell, stable threshold (ms).
   *  The content-aware settle catches setTimeout/hydration content networkidle misses. Defaults 5000 / 1500 / 400. */
  settleMs?: number;
  settleMinDwellMs?: number;
  settleStableMs?: number;
}

export class PlaywrightRenderer implements RenderPort {
  private readonly loadPlaywright: () => Promise<PlaywrightModule>;
  private readonly guard: BrowserUrlGuard;
  private readonly cdpEndpoint?: string;
  private readonly chromiumSandbox: boolean;
  private readonly settleMs: number;
  private readonly settleMinDwellMs: number;
  private readonly settleStableMs: number;
  /** Lazily-connected, reused CDP browser. Connecting per-render would leak a WebSocket every call. */
  private cdpBrowser?: PlaywrightBrowser;

  constructor(deps: PlaywrightRendererDeps = {}) {
    this.loadPlaywright = deps.loadPlaywright ?? defaultLoadPlaywright;
    this.guard = deps.guard ?? new P1BrowserUrlGuard();
    this.cdpEndpoint = parseCdpEndpoint(deps.cdpEndpoint ?? "");
    this.chromiumSandbox = deps.chromiumSandbox ?? true;
    this.settleMs = deps.settleMs ?? 5000; // #110: was 3000; both waits return early when stable, so a larger cap only helps slow-hydrating SPAs (total settle bounded by render timeoutMs).
    this.settleMinDwellMs = deps.settleMinDwellMs ?? 1500;
    this.settleStableMs = deps.settleStableMs ?? 400;
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const actions: RenderAction[] = [serviceWorkerAction()];
    const state = new RenderRouteState(input, actions, this.guard);
    let browser: PlaywrightBrowser | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;
    let ownsBrowser = false;
    let onSignalAbort: (() => void) | undefined;
    try {
      const playwright = await this.loadPlaywright();
      if (this.cdpEndpoint) {
        if (!this.cdpBrowser) this.cdpBrowser = await playwright.chromium.connectOverCDP(this.cdpEndpoint);
        browser = this.cdpBrowser;
      } else {
        browser = await playwright.chromium.launch({
          headless: true,
          chromiumSandbox: this.chromiumSandbox,
          env: {},
        });
        ownsBrowser = true;
      }
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      page = await context.newPage();
      // CANCEL the render on the bulk wall signal (codex R4 P2): close the page so an abandoned
      // render can't keep a browser slot + egress after the bulk returns (close rejects goto/settle).
      if (input.signal) {
        onSignalAbort = (): void => { void page?.close().catch(() => {}); };
        if (input.signal.aborted) onSignalAbort();
        else input.signal.addEventListener("abort", onSignalAbort, { once: true });
      }
      state.setMainFrame(page.mainFrame());
      await installPageControls(page, actions, input.timeoutMs);
      await page.route("**/*", (route) => state.handle(route));
      const startedAt = Date.now();
      const remaining = (): number => Math.max(0, input.timeoutMs - (Date.now() - startedAt));
      const response = await withTimeout(
        page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs }),
        input.timeoutMs,
      );
      // Idle-aware settle: networkidle then a content-stability dwell. The networkidle cap RESERVES
      // settleMinDwellMs for the content-stability phase; a 0 cap SKIPS the wait (timeout:0 = no-timeout hang).
      const networkidleCap = Math.min(this.settleMs, Math.max(0, remaining() - this.settleMinDwellMs));
      if (networkidleCap > 0) await page.waitForLoadState("networkidle", { timeout: networkidleCap }).catch(() => {});
      const settleCap = Math.min(this.settleMs, remaining());
      await waitForBodyStable(page, {
        capMs: settleCap,
        minDwellMs: Math.min(this.settleMinDwellMs, settleCap),
        stableMs: this.settleStableMs,
      });
      if (state.fatal) return renderFailure(state.fatal, actions, state);
      let content = await page.content();
      try {
        const main = page.mainFrame();
        for (const frame of page.frames()) {
          if (frame === main) continue;
          const frameContent = await frame.content();
          if (frameContent.length > 100) content += "\n" + frameContent;
        }
      } catch { /* iframe capture best-effort */ }
      const domTextLength = await liveDomTextLength(page); // #154: live DOM text (shadow-DOM/computed)
      // Advisory byte cap: truncate rendered HTML at the cap + keep it (with a note), not drop it.
      const { bytes, truncated } = capRenderedBytes(content, input.maxBytes);
      const notice: ProvenanceError | undefined = truncated
        ? { code: "max_bytes", message: `Rendered content truncated at ${input.maxBytes} bytes` }
        : undefined;
      return renderSuccess(input, page, response?.status() ?? state.status, bytes, state, notice, domTextLength);
    } catch (error) {
      return renderFailure(state.fatal ?? rejectFromError(error), actions, state);
    } finally {
      if (onSignalAbort && input.signal) input.signal.removeEventListener("abort", onSignalAbort);
      await closeQuietly(page);
      await closeQuietly(context);
      // Only close a browser we launched; the CDP sidecar is shared + long-lived.
      if (ownsBrowser) await closeQuietly(browser);
    }
  }
}

async function installPageControls(
  page: PlaywrightPage,
  actions: RenderAction[],
  timeoutMs: number,
): Promise<void> {
  page.setDefaultTimeout?.(timeoutMs);
  page.setDefaultNavigationTimeout?.(timeoutMs);
  page.on("download", (value) => blockDownload(value, actions));
  if (page.routeWebSocket) {
    await page.routeWebSocket("**/*", (socket) => closeWebSocket(socket, actions));
  } else {
    page.on("websocket", (value) => closeLegacyWebSocket(value, actions));
  }
}

function blockDownload(value: PlaywrightEventValue, actions: RenderAction[]): void {
  const download = value as PlaywrightDownload;
  actions.push({ type: "download-blocked", reason: "downloads disabled", url: safeRenderUrl(download.url()) });
  void download.cancel?.();
}

function closeLegacyWebSocket(value: PlaywrightEventValue, actions: RenderAction[]): void {
  const socket = value as PlaywrightWebSocket;
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  void socket.close?.();
}

async function closeWebSocket(socket: PlaywrightWebSocketRoute, actions: RenderAction[]): Promise<void> {
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  await socket.close();
}

function renderSuccess(input: RenderInput, page: PlaywrightPage, status: number, bytes: Uint8Array, state: RenderRouteState, notice: ProvenanceError | undefined, domTextLength: number | undefined): RenderOutput {
  const egressHosts = state.egressHosts();
  return {
    rendered: true,
    fetchResult: {
      status,
      finalUrl: state.finalUrl || safeRenderUrl(page.url()) || input.url,
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

/** UTF-8-safe truncation: cut at the largest char boundary ≤ maxBytes by walking
 *  back past trailing continuation bytes (0x80–0xBF) so the slice is always valid UTF-8. */
function capRenderedBytes(content: string, maxBytes: number): { bytes: Uint8Array; truncated: boolean } {
  const full = new TextEncoder().encode(content);
  if (full.byteLength <= maxBytes) return { bytes: full, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (full[cut] & 0xc0) === 0x80) cut -= 1;
  return { bytes: full.subarray(0, cut), truncated: true };
}

function renderFailure(rejected: RejectResult, actions: RenderAction[], state: RenderRouteState): RenderFailure {
  // A failed render may have fulfilled subresources before failing — carry the partial egress (codex R2 P2).
  const egressHosts = state.egressHosts();
  return { ...rejected, rendered: false, actions, egressBytes: state.egressBytes(), ...(egressHosts.length ? { egressHosts } : {}) };
}

async function defaultLoadPlaywright(): Promise<PlaywrightModule> {
  try { return await import("playwright") as unknown as PlaywrightModule; }
  catch { throw new RenderError("render_unavailable", "Playwright is not installed"); }
}

class RenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

function rejectFromError(error: unknown): RejectResult {
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

function serviceWorkerAction(): RenderAction { return { type: "service-workers-disabled", reason: "context serviceWorkers=block" }; }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("render_timeout")), timeoutMs);
  });
  try { return await Promise.race([promise, timer]); } finally { if (timeout) clearTimeout(timeout); }
}

async function closeQuietly(closeable: { close(): Promise<void> } | undefined): Promise<void> {
  try { await closeable?.close(); } catch { /* best-effort cleanup */ }
}
