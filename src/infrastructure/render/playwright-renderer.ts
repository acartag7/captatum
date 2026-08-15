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
    // ONE deadline for the whole render (codex P1 r2): established before CDP
    // resolution so DNS/connect, navigation, and settling share the single
    // per-tier timeoutMs budget instead of each phase getting a fresh full one.
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
        if (!this.cdpBrowser) {
          // Connect over the RESOLVED address: Chromium's DevTools server 500s any
          // request whose Host header is not an IP/localhost, so dialing the Service
          // DNS name fails at /json/version (observed in production; see cdp-connect.ts).
          // The resolution + connect run BEFORE the per-request timeout bookkeeping
          // below, so they carry their own bound: the render deadline AND the caller's
          // abort signal (the bulk wall) — a stalled DNS lookup must not hold a render
          // slot past either (codex P1).
          const endpoint = this.cdpEndpoint; // narrowed for the closure below
          if (input.signal?.aborted) throw new Error("render_timeout");
          const connect = (async () => playwright.chromium.connectOverCDP(
            await resolveCdpConnectUrl(endpoint, this.cdpResolver),
          ))();
          let connected = false;
          try {
            this.cdpBrowser = await withTimeout(
              input.signal
                ? Promise.race([connect, abortRejection(input.signal)])
                : connect,
              remaining(),
            );
            connected = true;
          } finally {
            // Lost the race (deadline/abort): a late-arriving browser must not
            // leak a live CDP WebSocket against the relay's 32-connection cap
            // (codex P2 r2) — close it when it lands and swallow the rejection.
            if (!connected) void connect.then((b) => b.close().catch(() => {})).catch(() => {});
          }
        }
        browser = this.cdpBrowser;
      } else {
        browser = await playwright.chromium.launch({
          headless: true,
          chromiumSandbox: this.chromiumSandbox,
          env: {},
          // Transport-layer egress page.route cannot see: WebRTC ICE/STUN sends
          // UDP from the browser's network position regardless of request
          // interception. Forbid non-proxied UDP so ICE cannot probe or
          // exfiltrate below the fetch guard (the hosted browser pod's netns
          // firewall already blocks this; the local in-process flavor has no
          // such firewall, so the flag is load-bearing there).
          args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
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
