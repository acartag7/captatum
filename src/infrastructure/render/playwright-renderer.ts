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
import { resolveCdpConnectUrl, type CdpHostResolver } from "./cdp-connect.ts";
import { RenderRouteState } from "./route-state.ts";
import {
  abortRejection,
  blockDownload,
  capRenderedBytes,
  closePopup,
  closeQuietly,
  closeLegacyWebSocket,
  closeWebSocket,
  rejectFromError,
  renderFailure,
  RenderError,
  renderSuccess,
  serviceWorkerAction,
  withTimeout,
} from "./renderer-helpers.ts";
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
  /** Allowlisted CDP endpoint for the isolated hosted browser workload. If set, the renderer connects to long-lived Chromium instead of launching one in-process. */
  cdpEndpoint?: string;
  /** Resolves the CDP Service hostname to the IP form Chromium's DevTools Host check accepts (test-injectable). */
  cdpResolver?: CdpHostResolver;
  /** Chromium OS sandbox for in-process launch. Default true — the threat model mandates sandbox on; --no-sandbox in-process is transitional local-only behavior. */
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
  private readonly cdpResolver?: CdpHostResolver;
  private readonly chromiumSandbox: boolean;
  private readonly settleMs: number;
  private readonly settleMinDwellMs: number;
  private readonly settleStableMs: number;
  /** Lazily-connected, reused CDP browser. Connecting per-render would leak a WebSocket every call. */
  private cdpBrowser?: PlaywrightBrowser;
  /** Single-flight connect (2026-09-01: concurrent first renders leaked relay connections). */
  private cdpConnecting?: Promise<PlaywrightBrowser>;
  /** Live waiters — late success with zero waiters closes (codex P2 r2), else caches. */
  private cdpWaiters = 0;

  constructor(deps: PlaywrightRendererDeps = {}) {
    this.loadPlaywright = deps.loadPlaywright ?? defaultLoadPlaywright;
    this.guard = deps.guard ?? new P1BrowserUrlGuard();
    this.cdpEndpoint = parseCdpEndpoint(deps.cdpEndpoint ?? "");
    this.cdpResolver = deps.cdpResolver;
    this.chromiumSandbox = deps.chromiumSandbox ?? true;
    this.settleMs = deps.settleMs ?? 5000; // #110: was 3000; both waits return early when stable, so a larger cap only helps slow-hydrating SPAs (total settle bounded by render timeoutMs).
    this.settleMinDwellMs = deps.settleMinDwellMs ?? 1500;
    this.settleStableMs = deps.settleStableMs ?? 400;
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const actions: RenderAction[] = [serviceWorkerAction()];
    const state = new RenderRouteState(input, actions, this.guard);
    // ONE deadline for the whole render (codex P1 r2): every phase shares the per-tier timeoutMs.
    const startedAt = Date.now();
    const remaining = (): number => Math.max(0, input.timeoutMs - (Date.now() - startedAt));
    let browser: PlaywrightBrowser | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;
    let ownsBrowser = false;
    let onSignalAbort: (() => void) | undefined;
    try {
      const playwright = await this.loadPlaywright();
      if (this.cdpEndpoint) {
        browser = await this.connectCdpSingleFlight(playwright, input, remaining());
      } else {
        browser = await playwright.chromium.launch({
          headless: true,
          chromiumSandbox: this.chromiumSandbox,
          env: {},
          // Transport-layer egress page.route cannot see, killed at BOTH layers:
          // (1) WebRTC ICE/STUN UDP — forbidden by the IP-handling policy (load-bearing
          // only where there is no netns firewall, i.e. the local in-process flavor);
          // (2) WebRTC TURN over TCP (codex P1 r4) — a dead loopback proxy refuses every
          // browser-originated TCP connection, TURN included. Route-fulfilled content
          // never touches the network, so rendering is unaffected.
          args: [
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--proxy-server=http://127.0.0.1:1",
          ],
        });
        ownsBrowser = true;
      }
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      page = await context.newPage();
      // CANCEL on abort (codex R4 P2): close the page so an abandoned render frees its slot.
      if (input.signal) {
        onSignalAbort = (): void => { void page?.close().catch(() => {}); };
        if (input.signal.aborted) onSignalAbort();
        else input.signal.addEventListener("abort", onSignalAbort, { once: true });
      }
      state.setMainFrame(page.mainFrame());
      await installPageControls(context, page, actions, input.timeoutMs);
      // POPUP-EGRESS FIX: route at the CONTEXT level. page.route covers only the
      // page and its frames — a window.open / target=_blank popup is a NEW target
      // whose requests egress browser-direct, bypassing the guarded FetcherPort
      // entirely (executed PoC: 5 uninstrumented connections incl. loopback
      // navigations). Context routing intercepts every page in the context, so
      // anything a popup fires before it is closed still resolves through the
      // same guarded fulfillment as any subresource.
      await context.route("**/*", (route) => state.handle(route));
      const response = await withTimeout(
        page.goto(input.url, { waitUntil: "domcontentloaded", timeout: remaining() }),
        remaining(),
      );
      // Idle-aware settle: networkidle then a content-stability dwell; a 0 cap skips the wait.
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
      return renderSuccess(input, page.url(), response?.status() ?? state.status, bytes, state, notice, domTextLength);
    } catch (error) {
      return renderFailure(state.fatal ?? rejectFromError(error), actions, state);
    } finally {
      if (onSignalAbort && input.signal) input.signal.removeEventListener("abort", onSignalAbort);
      await closeQuietly(page);
      await closeQuietly(context);
      // Only close a browser we launched; the remote CDP browser is shared + long-lived.
      if (ownsBrowser) await closeQuietly(browser);
    }
  }

  /** Connect over the RESOLVED address (Chromium's DevTools server 500s non-IP Host headers —
   * see cdp-connect.ts). Single-flight: the SHARED raw connect promise is started once and
   * cached on success (a late success IS the cache, not a leak); on failure the slot is
   * cleared so a later render retries. Each waiter races the shared attempt against ITS OWN
   * deadline + abort signal (codex round: a short-budget render must never hang on the
   * initiating caller's longer connect window). */
  private connectCdpSingleFlight(
    playwright: PlaywrightModule,
    input: RenderInput,
    remainingMs: number,
  ): Promise<PlaywrightBrowser> {
    if (this.cdpBrowser) return Promise.resolve(this.cdpBrowser);
    if (input.signal?.aborted) return Promise.reject(new Error("render_timeout"));
    if (!this.cdpConnecting) {
      const endpoint = this.cdpEndpoint;
      if (!endpoint) return Promise.reject(new Error("render_timeout"));
      const connect: Promise<PlaywrightBrowser> = (async () => playwright.chromium.connectOverCDP(
        await resolveCdpConnectUrl(endpoint, this.cdpResolver),
      ))();
      this.cdpConnecting = connect;
      void connect.then(
        (browser) => {
          if (this.cdpWaiters > 0) { this.cdpBrowser = browser; return; }
          // No waiter remains (every deadline fired): a late-arriving browser must not
          // linger against the relay's 32-connection cap (codex P2 r2 semantics kept).
          this.cdpConnecting = undefined;
          void browser.close().catch(() => {});
        },
        () => { if (this.cdpConnecting === connect) this.cdpConnecting = undefined; },
      );
    }
    this.cdpWaiters++;
    const attempt = withTimeout(
      input.signal ? Promise.race([this.cdpConnecting, abortRejection(input.signal)]) : this.cdpConnecting,
      remainingMs,
    );
    void attempt.finally(() => { this.cdpWaiters--; }).catch(() => {});
    return attempt;
  }
}

async function installPageControls(
  context: PlaywrightContext,
  page: PlaywrightPage,
  actions: RenderAction[],
  timeoutMs: number,
): Promise<void> {
  page.setDefaultTimeout?.(timeoutMs);
  page.setDefaultNavigationTimeout?.(timeoutMs);
  page.on("download", (value) => blockDownload(value, actions));
  // A fetch-render has no use for popups: close them on sight — at the CONTEXT
  // level, so a popup's own window.open (a popup-of-popup) is closed too, not
  // just top-level popups of the render page (page.on("popup") arms one page
  // only; codex P2 r3). Context-level routing (installed by render()) guards
  // anything a new page fires before the close lands, so neither layer depends
  // on the other's timing.
  context.on("page", (newPage) => {
    if (newPage === page) return;
    closePopup(newPage, actions);
  });
  if (context.routeWebSocket) {
    await context.routeWebSocket("**/*", (socket) => closeWebSocket(socket, actions));
  } else {
    page.on("websocket", (value) => closeLegacyWebSocket(value, actions));
  }
}

async function defaultLoadPlaywright(): Promise<PlaywrightModule> {
  try { return await import("playwright") as unknown as PlaywrightModule; }
  catch { throw new RenderError("render_unavailable", "Playwright is not installed"); }
}
