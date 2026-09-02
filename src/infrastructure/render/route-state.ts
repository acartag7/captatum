import type { FetcherResult, Redirect, RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderInput } from "../../application/ports/renderer.ts";
import { config } from "../../config.ts";
import type { PlaywrightFrame, PlaywrightRequest, PlaywrightRoute } from "./playwright-types.ts";
import { safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { registrableDomain } from "../../domain/registrable-domain.ts";
import { abortRoute } from "./route-abort.ts";
import { FetcherRouteFulfiller, type RouteFulfiller } from "./route-fulfill.ts";
import { RenderBytePool } from "./render-byte-pool.ts";
import { authorizePostForward, CORS_ALLOW_ORIGIN, materializePostForward, planOptionsPreflight } from "./post-forward.ts";
import { RenderEgressHosts } from "./render-egress.ts";
import { AsyncSemaphore, Semaphore } from "./semaphore.ts";
import { hostnameOf, isNavigation, shouldAbortWithoutBody } from "./route-helpers.ts";

/** Render resource types the page's CLIENT APP needs to load, or it throws a client-side
 *  exception (Next.js "Application error…"): scripts, data fetches/XHR, documents. Aborting one
 *  mid-load (an auth script like Clerk, a /api/flags the app awaits) crashes the app → error
 *  boundary instead of content, so these get the larger essential pool below (cerebralvalley). */
const ESSENTIAL_RENDER_TYPES = new Set(["script", "fetch", "xhr", "document"]);

/** The essential pool (script/fetch/xhr/document) gets a FIXED byte budget, DECOUPLED from the
 *  per-response `maxBytes` (#143: coupling aborted heavy-SPA bundles mid-load — Notion ~19MB —
 *  → render_empty). 48MB ≈ 2.5× the heaviest measured SPA yet a firm cumulative backstop
 *  (per-response maxBytes, blocked media, render timeoutMs remain). Non-essential keeps 1× maxBytes. */
export const ESSENTIAL_RENDER_BYTES = 48 * 1024 * 1024;

/** Max concurrent render subresource FETCHES; bounds the byte pool's per-pool crossing overage to N× maxBytes (codex R11 P1). */
export const RENDER_FETCH_CONCURRENCY = 2;

/** The bulk BudgetTracker reservation in perSeedMaxBytes units. = essentialCap(48MB) + non-essential(1×)
 *  + crossing(2×N per pool) per SeedMaxBytes, ceil'd. Decoupling the essential cap from maxBytes made
 *  this per-call (was a fixed 8× when essential was 3× maxBytes; codex R5/R11). */
export function renderEgressUnits(perSeedMaxBytes: number): number {
  return Math.ceil((ESSENTIAL_RENDER_BYTES + perSeedMaxBytes * (1 + 2 * RENDER_FETCH_CONCURRENCY)) / perSeedMaxBytes);
}

function isEssentialRenderType(resourceType: string): boolean {
  return ESSENTIAL_RENDER_TYPES.has(resourceType);
}

/**
 * Per-request route state for the Tier-3 render. The browser NEVER makes its own
 * egress: every non-aborted GET is resolved through the guarded FetcherPort and fulfilled with the
 * fetched bytes (`route.fulfill`), so the connection is pinned to the guard-resolved IP and every
 * redirect hop is re-validated against the SSRF guards (`maxHops` enforced). Ad/tracker + blocked
 * body types + non-GET requests are aborted before any network; aborted body types are still
 * P1/DNS private-IP-checked. This closes the DNS-rebinding + redirect TOCTOU `route.continue()` left
 * open (TIER3-SSRF-1/2/NAV-1) — Chromium no longer resolves or connects by name.
 */
export class RenderRouteState {
  readonly input: RenderInput;
  readonly actions: RenderAction[];
  readonly guard: BrowserUrlGuard;
  private readonly fulfiller: RouteFulfiller;
  private readonly mainHost: string;
  private readonly mainRegistrableDomain: string | null;
  private readonly postMaxBytes: number;
  private readonly postSemaphore: Semaphore;
  /** Bounds concurrent render subresource FETCHES so the byte pool's crossing overage stays within
   *  the bulk egress reservation (codex R11 P1). */
  private readonly fetchSem: AsyncSemaphore;
  status = 200;
  finalUrl = ""; redirects: FetcherResult["redirects"] = [];
  fatal?: RejectResult;
  /** Set by the renderer at teardown: later abort()s satisfy the browser but stay out of provenance. */
  teardown = false;
  private mainFrame?: PlaywrightFrame;
  // The two cumulative byte pools (essential + non-essential) bounding render subresource egress.
  private readonly pool: RenderBytePool;
  // Registrable domains of fulfilled subresources → Result.renderEgressHosts (BULK-3).
  private readonly egressHostsList = new RenderEgressHosts();

  constructor(input: RenderInput, actions: RenderAction[], guard: BrowserUrlGuard) {
    this.input = input;
    this.actions = actions; this.guard = guard;
    this.mainHost = hostnameOf(input.url);
    // Computed ONCE from the page URL; the POST first-party scope never expands mid-render.
    this.mainRegistrableDomain = registrableDomain(this.mainHost);
    // POST body cap = min(postMaxBytes, maxBytes) (codex R9 P2 — protects the byte-pool reservation).
    this.postMaxBytes = Math.min(config.render.postMaxBytes(), input.maxBytes);
    this.postSemaphore = new Semaphore(config.render.postConcurrency());
    this.fetchSem = new AsyncSemaphore(RENDER_FETCH_CONCURRENCY);
    this.pool = new RenderBytePool(ESSENTIAL_RENDER_BYTES, input.maxBytes);
    // Abort signal into every subresource fetch (codex R6 P2 — page.close() cannot cancel).
    this.fulfiller = new FetcherRouteFulfiller(input.fetcher, {
      maxBytes: input.maxBytes, timeoutMs: input.timeoutMs, maxHops: input.maxHops,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /** Set after the page exists; main-frame requests are told apart from iframe documents by frame === page.mainFrame(). */
  setMainFrame(frame: PlaywrightFrame): void {
    this.mainFrame = frame;
  }

  /** Total render network egress → `Result.egressBytes` (BULK-5). */
  egressBytes(): number { return this.pool.total(); }

  /** Registrable domains the render loaded subresources from → bulk per-host union (BULK-3). */
  egressHosts(): string[] { return this.egressHostsList.get(); }

  private countEgress(essential: boolean, bytes: number, url: string, redirects: Redirect[], finalUrl: string): void { this.pool.add(essential, bytes); this.egressHostsList.noteFulfilled(url, redirects, finalUrl); }

  /**
   * request.frame() throws for a navigation request Playwright hasn't created the
   * frame for yet (see Playwright's Request.frame docs). Treat that — and a
   * missing frame() — as "not main-frame" so the route still resolves (a guarded
   * reject is still aborted) rather than erroring or masking the reject.
   */
  private isMainFrame(request: PlaywrightRequest): boolean {
    try {
      return this.mainFrame !== undefined && request.frame?.() === this.mainFrame;
    } catch {
      return false;
    }
  }

  /** Re-gate after fetchSem.acquire (#143): without it a burst of M requests passes the pre-fetch gate
   *  before any marks exceeded → M×maxBytes; false = pool blew while queued (fetchSem released), caller aborts without fetching → bounded to N. Shared GET+POST (fetchSem shared; codex P1). */
  private postAcquireGate(essential: boolean): boolean {
    if (!this.pool.isExceeded(essential)) return true;
    this.fetchSem.release();
    return false;
  }

  async handle(route: PlaywrightRoute): Promise<void> {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();
    // The main-frame navigation is the page the user asked to fetch (never an ad/tracker); owns provenance.
    const mainFrameNav = isNavigation(request) && this.isMainFrame(request);
    if (!mainFrameNav && shouldAbortWithoutBody(url, resourceType, this.mainHost)) {
      return this.abortBlockedType(route, url, resourceType);
    }
    if (!mainFrameNav && request.method() !== "GET") {
      return this.handleNonGet(route, request, url, resourceType);
    }
    // Once a pool is blown, subsequent resources in THAT pool abort before network (essentials + non-essentials have separate pools).
    if (this.pool.isExceeded(isEssentialRenderType(resourceType))) {
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    await this.fetchSem.acquire(); // codex R11 P1: bound concurrent render fetches; postAcquireGate re-gates (#143).
    if (!this.postAcquireGate(isEssentialRenderType(resourceType))) return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    let outcome;
    try { outcome = await this.fulfiller.resolve(url, resourceType); } finally { this.fetchSem.release(); }
    if (outcome.kind === "reject") {
      // A truncated subresource's bytes were downloaded before the abort — count them (countFetched below runs only on fulfill) so the byte pool/egressBytes stay honest (#149 codex P2).
      if (outcome.countedBytes !== undefined) this.countEgress(isEssentialRenderType(resourceType), outcome.countedBytes, url, outcome.countedRedirects ?? [], outcome.countedFinalUrl ?? url);
      if (mainFrameNav) this.fatal = outcome.reject;
      return this.abort(route, url, resourceType, outcome.reject.code, "request-blocked");
    }
    if (mainFrameNav) {
      // The main-frame nav owns provenance (updated on EVERY nav; frame === page.mainFrame() separates subframes so an iframe can't clobber it).
      this.status = outcome.status;
      this.finalUrl = outcome.finalUrl;
      this.redirects = outcome.redirects;
      // Fidelity limit: the nav body is served against the ORIGINAL request URL (a cross-origin redirect's base stays the original origin; Set-Cookie isn't carried). Every hop was guard-validated.
    }
    const essential = isEssentialRenderType(resourceType);
    // Count EVERY resolved body + hosts — including cap-aborted ones (egress already happened; codex R2 P2).
    const countFetched = (): void => this.countEgress(essential, outcome.body.byteLength, url, outcome.redirects, outcome.finalUrl);
    if (this.pool.isExceeded(essential)) { // re-check after resolve (concurrent blow)
      countFetched();
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    if (this.pool.used(essential) + outcome.body.byteLength > this.pool.cap(essential)) {
      if (essential) {
        this.pool.markExceeded(true); // crossing essential: fulfill (counted below)
      } else {
        this.pool.markExceeded(false);
        countFetched(); // non-essential crossing: body fetched — count it before aborting
        return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
      }
    }
    countFetched();
    await route.fulfill({
      status: outcome.status,
      body: outcome.body,
      ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
    });
  }

  /** #111: non-GET Tier-3 — OPTIONS preflight → synthesized permissive response; first-party POST → forwarded via FetcherPort (body reserved, released on reject); else aborts. */
  private async handleNonGet(route: PlaywrightRoute, request: PlaywrightRequest, url: string, resourceType: string): Promise<void> {
    // CORS preflight (OPTIONS) for a cross-origin POST: synthesize a permissive first-party response (#111 codex P1).
    if (request.method() === "OPTIONS") {
      const pre = planOptionsPreflight({ resourceType, url, mainRegistrableDomain: this.mainRegistrableDomain });
      if (pre.kind === "abort") return this.abort(route, url, resourceType, pre.reason);
      await route.fulfill({ status: 204, body: new Uint8Array(0), headers: pre.headers });
      return;
    }
    const h = request.headers?.() ?? {};
    // Authorize (gate + Content-Length) BEFORE reading the body — reject an oversized DECLARED body without materializing it (#111 codex P1).
    const auth = authorizePostForward({
      method: request.method(), resourceType, url,
      contentLength: h["content-length"], mainRegistrableDomain: this.mainRegistrableDomain, maxBytes: this.postMaxBytes,
    });
    if (auth.kind === "abort") return this.abort(route, url, resourceType, auth.reason);
    const plan = materializePostForward({ body: request.postDataBuffer?.() ?? null, contentType: h["content-type"], maxBytes: this.postMaxBytes });
    if (plan.kind === "abort") return this.abort(route, url, resourceType, plan.reason);
    if (this.pool.isExceeded(true)) return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    if (!this.postSemaphore.tryAcquire()) return this.abort(route, url, resourceType, "render_concurrency_limit");
    try {
      await this.fetchSem.acquire(); // POST fetches bounded by the render fetch semaphore too (codex R13 P2)
      if (!this.postAcquireGate(true)) return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
      // Reserve + count the body POST re-gate (committed to send), not at dispatch (codex P2).
      this.pool.add(true, plan.body.byteLength);
      if (this.pool.used(true) > this.pool.cap(true)) this.pool.markExceeded(true);
      let outcome;
      try { outcome = await this.fulfiller.resolve(url, resourceType, plan.postInit); }
      finally { this.fetchSem.release(); }
      if (outcome.kind === "reject") {
        if (outcome.countedBytes !== undefined) this.countEgress(true, outcome.countedBytes, url, outcome.countedRedirects ?? [], outcome.countedFinalUrl ?? url); else this.pool.releaseEssential(plan.body.byteLength); // truncated POST response → count (keep body reservation); pre-send reject → release
        return this.abort(route, url, resourceType, outcome.reject.code, "request-blocked");
      }
      if (this.pool.isExceeded(true)) { // concurrent POST blew the pool; it fully egressed — count, then abort (codex R4 P2).
        this.pool.add(true, outcome.body.byteLength);
        this.egressHostsList.noteFulfilled(url, outcome.redirects, outcome.finalUrl);
        return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
      }
      if (this.pool.used(true) + outcome.body.byteLength > this.pool.cap(true)) this.pool.markExceeded(true);
      this.pool.add(true, outcome.body.byteLength);
      this.actions.push({ type: "request-forwarded-post", outcome: "ok", url: safeRenderUrl(url), resourceType, method: "POST", bodyBytes: plan.body.byteLength, responseBytes: outcome.body.byteLength });
      this.egressHostsList.noteFulfilled(url, outcome.redirects, outcome.finalUrl);
      // ACAO:* admits the cross-origin POST response (#111); credentialed CORS is a known limitation (rare; cookies stripped).
      await route.fulfill({
        status: outcome.status,
        body: outcome.body,
        ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
        headers: CORS_ALLOW_ORIGIN,
      });
    } finally {
      this.postSemaphore.release();
    }
  }

  private async abortBlockedType(route: PlaywrightRoute, url: string, resourceType: string): Promise<void> {
    // Guard check composes the render signal — a fresh timeout would outlive the result.
    const blocked = await this.guard.check(url, this.input.signal
      ? AbortSignal.any([AbortSignal.timeout(this.input.timeoutMs), this.input.signal])
      : AbortSignal.timeout(this.input.timeoutMs));
    const reason = blocked?.code ?? `blocked_${resourceType}`;
    await this.abort(route, url, resourceType, reason, "resource-aborted");
  }

  private abort(route: PlaywrightRoute, url: string, resourceType: string, reason: string, type?: RenderAction["type"]): Promise<void> {
    return abortRoute(route, { actions: this.actions, teardown: this.teardown, url, resourceType, reason, type });
  }
}