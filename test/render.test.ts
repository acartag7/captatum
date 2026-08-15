import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { BrowserUrlGuard } from "../src/infrastructure/render/index.ts";
import { PlaywrightRenderer, createRenderer } from "../src/infrastructure/render/index.ts";
import { ESSENTIAL_RENDER_BYTES, RENDER_FETCH_CONCURRENCY, renderEgressUnits, RenderRouteState } from "../src/infrastructure/render/route-state.ts";
import { RenderBytePool } from "../src/infrastructure/render/render-byte-pool.ts";
import type { PlaywrightRoute } from "../src/infrastructure/render/playwright-types.ts";

test("renderer lazy-loads Playwright only when render is invoked", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({ loadPlaywright: harness.load });

  assert.equal(harness.loadCalls, 0);
  await renderer.render(renderInput(new FakeFetcher()));

  assert.equal(harness.loadCalls, 1);
});

test("renderer launches sandboxed context with service workers and downloads disabled", async () => {
  const harness = new BrowserHarness({
    downloadUrl: "https://public.test/file.zip",
    websocketUrl: "wss://public.test/socket",
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.deepEqual(harness.launchOptions.env, {});
  assert.equal(harness.launchOptions.chromiumSandbox, true);
  assert.deepEqual(harness.contextOptions, {
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  assert.equal(harness.downloadCanceled, true);
  assert.equal(harness.websocketClosed, true);
  assert.deepEqual(result.actions.map((action) => action.type), [
    "service-workers-disabled",
    "websocket-closed",
    "download-blocked",
  ]);
});

test("renderer fulfills the public navigation through the fetcher and blocks private subresources", async () => {
  const navUrl = "https://public.test/";
  const privateUrl = "http://169.254.169.254/latest.js";
  // The fetcher is now the SSRF enforcer: every non-aborted request resolves
  // through fetchGuarded (IP-pinned, per-hop redirect revalidation). A private
  // subresource is rejected here, not by a name-only browser guard.
  const fetcher = new FakeFetcher({
    [privateUrl]: {
      rejected: true,
      code: "private_address",
      message: "Host resolves to a private or reserved address",
    },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true), request(privateUrl, "script")],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  // The navigation is fulfilled with the fetcher's bytes — never route.continue()'d,
  // so Chromium makes no egress of its own. Every request routed through the fetcher.
  assert.equal(harness.routes[0]?.fulfilled, true);
  assert.equal(harness.routes[0]?.continued, false);
  assert.equal(harness.routes[0]?.body, "<html>ok</html>");
  assert.deepEqual(fetcher.calls.map((call) => call.url), [navUrl, privateUrl]);
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "request-blocked",
    reason: "private_address",
    url: "http://169.254.169.254/latest.js",
    resourceType: "script",
  });
});

test("renderer fails closed when a navigation redirects (via the fetcher) to a private host", async () => {
  const navUrl = "https://public.test/redirect";
  // fetchGuarded follows redirects internally and rejects at the private hop;
  // the browser never sees the redirect, so Playwright's continue-redirect FSM
  // (TIER3-NAV-1) is out of the egress path entirely.
  const fetcher = new FakeFetcher({
    [navUrl]: {
      rejected: true,
      code: "private_address",
      message: "Redirect target resolves to a private or reserved address",
    },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "private_address");
  assert.equal(harness.routes[0]?.aborted, true);
});

test("renderer fulfills a navigation served without Content-Type as text/html (not a download)", async () => {
  const navUrl = "https://public.test/";
  // A navigation whose response carries no Content-Type must still render.
  // Defaulting to application/octet-stream makes Chromium treat it as a download
  // (page.goto throws) — a regression vs route.continue()'s MIME sniffing.
  const fetcher = new FakeFetcher({
    [navUrl]: { ...fetchResult("<html><body>ok</body></html>", navUrl), contentType: "" },
  });
  const harness = new BrowserHarness({ requests: [request(navUrl, "document", true)] });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true);
  assert.equal(harness.routes[0]?.contentType, "text/html; charset=utf-8");
});

test("renderer defaults a header-less script to text/javascript (Chromium won't execute text/html)", async () => {
  const navUrl = "https://public.test/";
  const scriptUrl = "https://cdn.test/app.js";
  // A script whose CDN omits Content-Type must be served as a JS MIME — defaulting
  // to text/html (as a global default would) makes Chromium refuse to run it.
  const fetcher = new FakeFetcher({
    [scriptUrl]: { ...fetchResult("document.body.dataset.app='ran';", scriptUrl), contentType: "" },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true), request(scriptUrl, "script")],
  });

  await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(harness.routes.at(-1)?.fulfilled, true);
  assert.equal(harness.routes.at(-1)?.contentType, "text/javascript");
});

test("renderer keeps the main-frame finalUrl; an iframe navigation does not overwrite it", async () => {
  const mainUrl = "https://public.test/";
  const iframeUrl = "https://embed.test/frame";
  // Both are navigations; the iframe is a subframe (mainFrame=false). Without the
  // frame-based guard the iframe would overwrite finalUrl.
  const fetcher = new FakeFetcher({
    [iframeUrl]: fetchResult("<html>iframe</html>", iframeUrl),
  });
  const harness = new BrowserHarness({
    requests: [request(mainUrl, "document", true), request(iframeUrl, "document", true, false)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.fetchResult.finalUrl, mainUrl);
});

test("renderer updates finalUrl on a later main-frame navigation (same-tab client-side nav)", async () => {
  const firstUrl = "https://public.test/first";
  const canonicalUrl = "https://public.test/canonical";
  // A page that performs a client-side same-tab navigation after the first load
  // (location.href = '/canonical') is a SECOND main-frame navigation; provenance
  // must track it, not stay stuck on the first.
  const fetcher = new FakeFetcher({
    [canonicalUrl]: fetchResult("<html>canonical body</html>", canonicalUrl),
  });
  const harness = new BrowserHarness({
    requests: [request(firstUrl, "document", true), request(canonicalUrl, "document", true)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.fetchResult.finalUrl, canonicalUrl);
});

test("renderer tolerates a navigation request whose frame() throws (early navigation)", async () => {
  const navUrl = "https://public.test/early";
  // Per Playwright docs, request.frame() throws for a navigation issued before
  // its frame is created; isMainFrame must swallow that so the route still
  // resolves instead of turning the render into render_error.
  const harness = new BrowserHarness({
    requests: [{
      url: navUrl, resourceType: "document", navigation: true, mainFrame: true,
      method: "GET", frameThrows: true,
    }],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true);
});

test("adblock never aborts the main-frame nav or first-party subresources of a vendor apex (codex SF-4)", async () => {
  // amplitude.com is in the adblock list, but when it IS the fetched page its
  // top-level document and own (sub)domain subresources must still load; only
  // third-party tracker subresources are aborted.
  const harness = new BrowserHarness({
    requests: [
      request("https://amplitude.com/", "document", true, true),
      request("https://cdn.amplitude.com/assets/app.js", "script", false, true),
      request("https://doubleclick.net/ad.js", "script", false, true),
    ],
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { url: "https://amplitude.com/" }));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true, "main-frame nav to vendor apex fulfilled (not adblocked)");
  assert.equal(harness.routes[1]?.fulfilled, true, "first-party subresource fulfilled (not adblocked)");
  assert.equal(harness.routes[2]?.aborted, true, "third-party tracker subresource aborted");
});

test("renderer checks private image URLs before aborting blocked body types", async () => {  const imageUrl = "http://127.0.0.1/pixel.png";
  const guard = new FakeGuard({
    [imageUrl]: { rejected: true, code: "private_address", message: "blocked" },
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true),
      request(imageUrl, "image"),
    ],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.ok(guard.calls.includes(imageUrl));
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "resource-aborted",
    reason: "private_address",
    url: "http://127.0.0.1/pixel.png",
    resourceType: "image",
  });
});

test("renderer truncates rendered HTML at the byte cap (advisory, not fatal)", async () => {
  const harness = new BrowserHarness({ content: "<main>too large to fit here</main>" });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { maxBytes: 8 }));

  // Advisory: a rendered page that exceeds the cap is truncated and returned
  // with a max_bytes provenance note, not rejected wholesale (the bytes are
  // already in memory; throwing them away would waste the whole render).
  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.notice?.code, "max_bytes");
  assert.ok(result.fetchResult.bytes <= 8, `expected <= 8 bytes, got ${result.fetchResult.bytes}`);
  assert.equal(harness.browserClosed, true);
});

test("render byte budget aborts non-essential types but never essential scripts/fetches (cerebralvalley clerk.js)", async () => {
  // Aborting a script/fetch mid-load crashes the client app (Next.js shows
  // "Application error: a client-side exception has occurred"). Essential render
  // types (script/fetch/xhr/document) are exempt from the cumulative budget; each
  // is still per-response maxBytes-capped by the fetcher.
  const fetcher = new FakeFetcher({
    "https://public.test/a.css": fetchResult("x".repeat(80), "https://public.test/a.css"),
    "https://public.test/b.css": fetchResult("y".repeat(50), "https://public.test/b.css"),
    "https://public.test/app.js": fetchResult("z".repeat(60), "https://public.test/app.js"),
    "https://public.test/flags": fetchResult("{}{}{}{}{}", "https://public.test/flags"),
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true), // nav 11 bytes → total 11
      request("https://public.test/a.css", "stylesheet"), // 80 → total 91 (fulfilled)
      request("https://public.test/b.css", "stylesheet"), // 50 → 141 > 100 → aborted (non-essential), budget exceeded
      request("https://public.test/app.js", "script"), // essential → fulfilled despite budget
      request("https://public.test/flags", "fetch"), // essential → fulfilled despite budget
    ],
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher, { maxBytes: 100 }));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true, "nav fulfilled");
  assert.equal(harness.routes[1]?.fulfilled, true, "stylesheet under budget fulfilled");
  assert.equal(harness.routes[2]?.aborted, true, "stylesheet over budget aborted (non-essential)");
  assert.equal(harness.routes[3]?.fulfilled, true, "script fulfilled over budget (essential — aborting crashes the app)");
  assert.equal(harness.routes[4]?.fulfilled, true, "fetch fulfilled over budget (essential)");
});

test("RenderBytePool: essentials cross → crosser counted + pool marked exceeded; later essentials see isExceeded (DoS backstop, #143)", () => {
  // The essential cap is a FIXED 48MB (ESSENTIAL_RENDER_BYTES), decoupled from maxBytes — too large
  // to cross with test-sized scripts, so the crossing LOGIC is unit-tested on the pool directly.
  // RenderRouteState.handle consults isExceeded() before + after each fetch and marks the essential
  // pool exceeded on a crossing response (which is still FULFILLED — aborting mid-load crashes the app).
  const pool = new RenderBytePool(300, 100); // essentialCap 300, nonEssentialCap 100 (test scale)
  assert.equal(pool.isExceeded(true), false);
  pool.add(true, 200); // s1: 200 ≤ 300
  assert.equal(pool.used(true), 200);
  assert.equal(pool.isExceeded(true), false);
  pool.add(true, 200); // s2: 400 > 300 → crossing; handle() marks exceeded but fulfills s2
  pool.markExceeded(true);
  assert.equal(pool.isExceeded(true), true, "the crossing essential marks the pool blown");
  assert.equal(pool.used(true), 400, "the crossing response is COUNTED (egress already happened)");
  assert.equal(pool.cap(true), 300);
  // Once exceeded, handle()'s pre-fetch isExceeded check aborts s3/s4 before network (no add).
});

test("RenderBytePool: the essential exceeded flag is sticky for real egress (a POST body is reserved only post-re-gate, so it never sets a transient dispatch flag — codex P2 root fix on #147)", () => {
  // The body is reserved AFTER the post-acquire re-gate (the POST is committed to send), not at dispatch,
  // so an unsent body can no longer transiently mark the pool exceeded. A real crossing (actual egress)
  // sets the flag via markExceeded and it stays sticky (the DoS backstop); releaseEssential only reverses
  // a resolve() reject that happened before the body counted as egress.
  const pool = new RenderBytePool(100, 50);
  pool.add(true, 95);
  assert.equal(pool.isExceeded(true), false);
  pool.add(true, 20);                        // 115 > 100 — real egress crossing
  pool.markExceeded(true);
  assert.equal(pool.isExceeded(true), true);
  pool.releaseEssential(5);                  // a pre-send reject partial release → 110, still > 100
  assert.equal(pool.isExceeded(true), true, "a real crossing stays exceeded (releaseEssential does not clear the flag)");
});


test("renderEgressUnits: the bulk render reservation is decoupled from maxBytes (#143) — per-call, not a fixed 8×", () => {
  // Was a constant 8× when the essential cap was 3× maxBytes. Now essential is a fixed 48MB, so the
  // reservation in perSeedMaxBytes units scales with 1/perSeedMaxBytes (smaller perSeed → more units).
  // = ceil((ESSENTIAL_RENDER_BYTES + perSeed×(1 + 2×RENDER_FETCH_CONCURRENCY)) / perSeed).
  assert.equal(renderEgressUnits(5 * 1024 * 1024), 15, "5MB perSeed → ceil((48+25)/5) = 15 units");
  assert.equal(renderEgressUnits(1024 * 1024), 53, "1MB perSeed → ceil((48+5)/1) = 53 units");
  assert.ok(renderEgressUnits(5 * 1024 * 1024) * (5 * 1024 * 1024) > ESSENTIAL_RENDER_BYTES, "reservation always exceeds the essential cap");
});

test("render byte budget bounds a CONCURRENT essential burst to ~cap + N×maxBytes, not M×maxBytes (#143 review)", async () => {
  // The post-acquire isExceeded re-gate bounds a page that bursts M essential requests at once. Without
  // it, all M pass the pre-fetch gate before the first resolves + marks exceeded, queue on the semaphore,
  // and each fetches a full maxBytes body → M×maxBytes (the verifier reproduced 105MB for 20×5MB vs a 48MB
  // cap — a bandwidth-amplification DoS). The sequential BrowserHarness.goto() await-loop MASKS this
  // (handle() calls never overlap), so this test drives RenderRouteState.handle() DIRECTLY with Promise.all.
  const body = 5 * 1024 * 1024;
  const M = 20;
  const big = "x".repeat(body);
  const results: Record<string, FetcherResult> = {};
  for (let i = 0; i < M; i++) results[`https://public.test/f${i}`] = fetchResult(big, `https://public.test/f${i}`);
  const state = new RenderRouteState(renderInput(new FakeFetcher(results), { maxBytes: body }), [], new FakeGuard({}));
  const routes: PlaywrightRoute[] = [];
  for (let i = 0; i < M; i++) {
    const url = `https://public.test/f${i}`;
    routes.push({
      request: () => ({ url: () => url, method: () => "GET", resourceType: () => "fetch", isNavigationRequest: () => false, frame: () => null }),
      fulfill: async () => {}, abort: async () => {}, continue: async () => {},
    } as unknown as PlaywrightRoute);
  }
  await Promise.all(routes.map((r) => state.handle(r)));
  const egress = state.egressBytes();
  // The fix: NOT all M fetched (was the bug — M×maxBytes = 100MB). The re-gate aborted the overflow once
  // the essential pool blew, bounding past-the-gate fetches into resolve() to N=2.
  assert.ok(egress < M * body, `concurrent burst did NOT egress M×maxBytes (${M * body} = the bug); got ${egress}`);
  // Bounded to ~cap + N×maxBytes crossing (the essential pool's in-flight overage when it blows).
  assert.ok(egress <= ESSENTIAL_RENDER_BYTES + 2 * RENDER_FETCH_CONCURRENCY * body, `bounded to ~cap + 2×N×maxBytes; got ${egress}`);
  // And the page DID load essentials up to the cap (the re-gate doesn't starve a legitimate burst).
  assert.ok(egress >= ESSENTIAL_RENDER_BYTES, `essentials loaded up to the cap; got ${egress}`);
});

test("render byte budget bounds a CONCURRENT GET+POST burst — the POST path's post-acquire re-gate (codex P1)", async () => {
  // The POST path (handleNonGet) shares fetchSem with GET, so its post-acquire re-gate (postAcquireGate)
  // bounds POST-response crossing to N too. Without it, up to postSemaphore (6) POSTs past the pre-fetch
  // gate each fetch a full maxBytes response after the pool blows — codex P1. POSTs alone can't cross the
  // 48MB cap (postSemaphore×6MB=36MB), so this mixes 8 GETs (40MB, under cap) with 6 first-party POSTs
  // (1MB body + 5MB response) so the cap blows on POST responses. Dispatched CONCURRENTLY (Promise.all).
  const fiveMb = 5 * 1024 * 1024;
  const oneMb = 1024 * 1024;
  const gets = Array.from({ length: 8 }, (_, i) => `https://public.test/g${i}`);
  const posts = Array.from({ length: 6 }, (_, i) => `https://public.test/api/p${i}`);
  const results: Record<string, FetcherResult> = {};
  for (const u of [...gets, ...posts]) results[u] = fetchResult("x".repeat(fiveMb), u);
  const state = new RenderRouteState(renderInput(new FakeFetcher(results), { maxBytes: fiveMb }), [], new FakeGuard({}));
  const postBody = new TextEncoder().encode("z".repeat(oneMb));
  const mk = (u: string, method: "GET" | "POST"): PlaywrightRoute => ({
    request: () => ({
      url: () => u, method: () => method, resourceType: () => "fetch", isNavigationRequest: () => false, frame: () => null,
      ...(method === "POST" ? { headers: () => ({ "content-type": "application/json", "content-length": String(oneMb) }), postDataBuffer: () => postBody } : {}),
    }),
    fulfill: async () => {}, abort: async () => {}, continue: async () => {},
  } as unknown as PlaywrightRoute);
  await Promise.all([...gets.map((u) => mk(u, "GET")), ...posts.map((u) => mk(u, "POST"))].map((r) => state.handle(r)));
  const egress = state.egressBytes();
  // Without the POST re-gate this approaches 8×5MB (GETs) + 6×1MB (POST bodies) + 6×5MB (POST responses)
  // = 76MB (all 6 POST responses fetch past the blown pool). The re-gate bounds POST responses to N crossing.
  assert.ok(egress < 70 * 1024 * 1024, `POST re-gate bounded the mixed burst (codex P1 gap was ~76MB); got ${egress}`);
  assert.ok(egress >= ESSENTIAL_RENDER_BYTES, `the burst crossed the cap (GETs+POSTs did load); got ${egress}`);
});

test("POST body is reserved POST re-gate, not at dispatch — a POST queued at fetchSem does NOT reserve its body (codex P2 root fix on #147)", async () => {
  // Root fix for codex P2 r3: the body is reserved AFTER the post-acquire re-gate (POST committed to send),
  // not at dispatch. So a POST queued behind occupied fetchSem permits can't transiently mark the pool
  // exceeded + block other essentials during the wait. Verified by holding both permits with never-resolving
  // GETs, dispatching a POST (it queues), and asserting its body was NOT counted. The sync FakeFetcher can't
  // reproduce this (it never holds fetchSem), so this uses a delaying fetcher.
  let releaseGets: () => void = () => {};
  const getBlocked = new Promise<void>((r) => { releaseGets = r; });
  const fetcher: FetcherPort = {
    async fetchGuarded(url: string): Promise<FetcherResult | RejectResult> {
      if (url.includes("/get")) await getBlocked;
      const b = new TextEncoder().encode("x");
      return { status: 200, finalUrl: url, redirects: [], bodyStream: new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }), contentType: "application/json", bytes: 1 };
    },
  };
  const state = new RenderRouteState(renderInput(fetcher, { maxBytes: 1024 * 1024 }), [], new FakeGuard({}));
  const mk = (u: string, method: "GET" | "POST"): PlaywrightRoute => ({
    request: () => ({
      url: () => u, method: () => method, resourceType: () => "fetch", isNavigationRequest: () => false, frame: () => null,
      ...(method === "POST" ? { headers: () => ({ "content-type": "application/json", "content-length": "1024" }), postDataBuffer: () => new Uint8Array(1024) } : {}),
    }),
    fulfill: async () => {}, abort: async () => {}, continue: async () => {},
  } as unknown as PlaywrightRoute);
  const g1 = state.handle(mk("https://public.test/get1", "GET")); // occupy permit 1 (blocks forever)
  const g2 = state.handle(mk("https://public.test/get2", "GET")); // occupy permit 2 (blocks forever)
  await new Promise((r) => setTimeout(r, 20));                     // let both GETs reach + hold fetchSem
  const before = state.egressBytes();
  const post = state.handle(mk("https://public.test/api/p", "POST")); // queues at fetchSem (both permits held)
  await new Promise((r) => setTimeout(r, 20));                     // let the POST reach fetchSem.acquire (queued)
  assert.equal(state.egressBytes(), before, `the queued POST did NOT reserve its body (reserved post-re-gate, not at dispatch — codex P2 root fix); gained ${state.egressBytes() - before}`);
  releaseGets();
  await Promise.allSettled([g1, g2, post]);
});


test("renderer concatenates captured iframe content into the rendered HTML", async () => {
  const harness = new BrowserHarness({
    content: "<html><head><title>Host Page</title></head><body>host body text</body></html>",
    extraFrameContent: '<script type="application/ld+json">{"@type":"JobPosting","title":"Embedded Job"}</script><p>embedded widget body</p>',
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  const text = await new Response(result.fetchResult.bodyStream).text();
  assert.ok(text.includes("host body text"), "host page content present");
  assert.ok(text.includes("Embedded Job"), "iframe JSON-LD captured");
  assert.ok(text.includes("embedded widget body"), "iframe body captured");
});

test("renderer byte-cap truncation respects UTF-8 boundaries for multibyte content", async () => {
  // "aaaaa😀" is 9 bytes (5 ASCII + a 4-byte emoji); a 60-byte cap lands mid-emoji.
  const harness = new BrowserHarness({ content: "aaaaa😀".repeat(50) });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { maxBytes: 60 }));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.notice?.code, "max_bytes");
  assert.ok(result.fetchResult.bytes <= 60, `expected <= 60 bytes, got ${result.fetchResult.bytes}`);
  // Truncated bytes must decode as valid UTF-8 — no dangling partial sequence.
  const decoded = await new Response(result.fetchResult.bodyStream).text();
  assert.equal(Buffer.from(decoded, "utf8").toString("utf8"), decoded);
});

test("a stalled CDP DNS resolution fails within the render deadline, not never (codex P1)", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({
    loadPlaywright: harness.load,
    guard: new FakeGuard({}),
    cdpEndpoint: "http://captatum-browser.captatum.svc.cluster.local:9222",
    // CoreDNS unavailable: the lookup never settles.
    cdpResolver: () => new Promise<string>(() => {}),
  });
  const input = renderInput(new FakeFetcher());
  const t0 = Date.now();
  const result = await renderer.render({ ...input, timeoutMs: 150 });
  const elapsed = Date.now() - t0;
  assert.equal(result.rendered, false);
  assert.equal(result.code, "timeout");
  assert.ok(elapsed < 5_000, `stalled resolution must be deadline-bounded, took ${elapsed}ms`);
});

test("an already-aborted bulk wall rejects the CDP connect before any browser work", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({
    loadPlaywright: harness.load,
    guard: new FakeGuard({}),
    cdpEndpoint: "http://captatum-browser.captatum.svc.cluster.local:9222",
    cdpResolver: () => new Promise<string>(() => {}),
  });
  const input = renderInput(new FakeFetcher());
  const result = await renderer.render({ ...input, timeoutMs: 5_000, signal: AbortSignal.abort() });
  assert.equal(result.rendered, false);
  assert.equal(result.code, "timeout");
});

test("renderer returns timeout and closes the browser on stalled navigation", async () => {
  const harness = new BrowserHarness({ neverResolve: true });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
    .render(renderInput(new FakeFetcher(), { timeoutMs: 5 }));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "timeout");
  assert.equal(harness.browserClosed, true);
});

test("renderer connects to the CDP workload and does not close its shared browser", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({
    loadPlaywright: harness.load,
    guard: new FakeGuard({}),
    cdpEndpoint: "http://captatum-browser.captatum.svc.cluster.local:9222",
    cdpResolver: async () => "10.43.38.129",
  });
  const result = await renderer.render(renderInput(new FakeFetcher()));

  // Workload mode: connect over CDP at the RESOLVED address (Chromium's DevTools
  // server 500s non-IP Host headers, so the Service DNS name cannot be dialed
  // directly — see src/infrastructure/render/cdp-connect.ts), and never close
  // the long-lived shared browser — only the per-render context+page.
  assert.equal(result.rendered, true);
  assert.equal(harness.cdpEndpoint, "http://10.43.38.129:9222");
  assert.equal(harness.launchCalled, false);
  assert.equal(harness.browserClosed, false);
});

interface ScriptedRequest {
  url: string;
  resourceType: string;
  navigation: boolean;
  mainFrame: boolean;
  method: string;
  frameThrows?: boolean;
}

class BrowserHarness {
  loadCalls = 0;
  launchCalled = false;
  launchOptions: Record<string, unknown> = {};
  cdpEndpoint?: string;
  contextOptions: Record<string, unknown> = {};
  routes: FakeRoute[] = [];
  loadStateCalls: { state: string; timeout?: number }[] = [];
  browserClosed = false;
  downloadCanceled = false;
  websocketClosed = false;
  // Stable frame sentinels so request.frame() === mainFrame distinguishes the
  // top-level document from an iframe navigation (matches page.mainFrame()).
  readonly mainFrame = {};
  readonly subFrame = {};
  private readonly options: {
    requests?: ScriptedRequest[];
    content?: string;
    extraFrameContent?: string;
    downloadUrl?: string;
    websocketUrl?: string;
    neverResolve?: boolean;
  };
  private routeHandler?: (route: FakeRoute) => Promise<void> | void;
  private websocketHandler?: (socket: FakeWebSocket) => Promise<void> | void;
  private downloadHandler?: (download: FakeDownload) => void;

  constructor(options: BrowserHarness["options"] = {}) {
    this.options = options;
  }

  load = async () => {
    this.loadCalls += 1;
    return {
      chromium: {
        launch: async (options: Record<string, unknown>) => {
          this.launchCalled = true;
          this.launchOptions = options;
          return this.browser();
        },
        connectOverCDP: async (endpoint: string) => {
          this.cdpEndpoint = endpoint;
          return this.browser();
        },
      },
    };
  };

  private browser() {
    return {
      newContext: async (options: Record<string, unknown>) => {
        this.contextOptions = options;
        return { newPage: async () => this.page(), close: async () => {} };
      },
      close: async () => {
        this.browserClosed = true;
      },
    };
  }

  private page() {
    // mainFrame is the harness instance sentinel (=== the detector's mainFrame);
    // extraFrame is a distinct object so the renderer's iframe loop (skip
    // frame === main) captures it when configured.
    const extraFrame = this.options.extraFrameContent !== undefined
      ? { content: async () => this.options.extraFrameContent as string }
      : undefined;
    return {
      route: async (_pattern: string, handler: (route: FakeRoute) => Promise<void> | void) => {
        this.routeHandler = handler;
      },
      routeWebSocket: async (
        _pattern: string,
        handler: (socket: FakeWebSocket) => Promise<void> | void,
      ) => {
        this.websocketHandler = handler;
      },
      on: (event: "download", handler: (download: FakeDownload) => void) => {
        if (event === "download") this.downloadHandler = handler;
      },
      setDefaultTimeout: (_timeoutMs: number) => {},
      setDefaultNavigationTimeout: (_timeoutMs: number) => {},
      goto: async (url: string) => await this.goto(url),
      // The real renderer waits for client-side widgets after DOMContentLoaded
      // (commit 9bba8aa) and captures iframe content (commit d50a3c9).
      waitForTimeout: async (_ms: number) => {},
      waitForLoadState: async (_state: string, _options?: { timeout?: number }) => {
        this.loadStateCalls.push({ state: _state, timeout: _options?.timeout });
      },
      mainFrame: () => this.mainFrame,
      frames: () => (extraFrame ? [this.mainFrame, extraFrame] : [this.mainFrame]),
      content: async () => this.options.content ?? "<main>rendered</main>",
      url: () => "https://public.test/",
      close: async () => {},
    };
  }

  private async goto(url: string) {
    if (this.options.neverResolve) return await new Promise<never>(() => {});
    const requests = this.options.requests ?? [request(url, "document", true)];
    for (const scripted of requests) {
      const route = new FakeRoute(scripted, this);
      this.routes.push(route);
      await this.routeHandler?.(route);
    }
    if (this.options.websocketUrl && this.websocketHandler) {
      await this.websocketHandler(new FakeWebSocket(this.options.websocketUrl, this));
    }
    if (this.options.downloadUrl && this.downloadHandler) {
      this.downloadHandler(new FakeDownload(this.options.downloadUrl, this));
    }
    return { status: () => this.routes[0]?.status ?? 200 };
  }
}

class FakeRoute {
  aborted = false;
  continued = false;
  fulfilled = false;
  status = 0;
  body = "";
  contentType?: string;
  readonly scripted: ScriptedRequest;
  private readonly harness: BrowserHarness;

  constructor(scripted: ScriptedRequest, harness: BrowserHarness) {
    this.scripted = scripted;
    this.harness = harness;
  }

  request() {
    return {
      url: () => this.scripted.url,
      method: () => this.scripted.method,
      resourceType: () => this.scripted.resourceType,
      isNavigationRequest: () => this.scripted.navigation,
      frame: () => {
        // Per Playwright docs, request.frame() throws for a navigation issued
        // before its frame is created.
        if (this.scripted.frameThrows) throw new Error("frame not created yet");
        return this.scripted.mainFrame ? this.harness.mainFrame : this.harness.subFrame;
      },
    };
  }

  async fulfill(options: { status: number; body?: Uint8Array; contentType?: string }): Promise<void> {
    this.fulfilled = true;
    this.status = options.status;
    this.contentType = options.contentType;
    this.body = options.body ? new TextDecoder().decode(options.body) : "";
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async continue(): Promise<void> {
    this.continued = true;
  }
}

class FakeDownload {
  readonly value: string;
  private readonly harness: BrowserHarness;

  constructor(value: string, harness: BrowserHarness) {
    this.value = value;
    this.harness = harness;
  }

  url(): string {
    return this.value;
  }

  async cancel(): Promise<void> {
    this.harness.downloadCanceled = true;
  }
}

class FakeWebSocket {
  readonly value: string;
  private readonly harness: BrowserHarness;

  constructor(value: string, harness: BrowserHarness) {
    this.value = value;
    this.harness = harness;
  }

  url(): string {
    return this.value;
  }

  async close(): Promise<void> {
    this.harness.websocketClosed = true;
  }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly results: Record<string, FetcherResult | RejectResult>;

  constructor(results: Record<string, FetcherResult | RejectResult> = {}) {
    this.results = results;
  }

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    return this.results[url] ?? fetchResult("<html>ok</html>", url);
  }
}

class FakeGuard implements BrowserUrlGuard {
  readonly calls: string[] = [];
  private readonly results: Record<string, RejectResult>;

  constructor(results: Record<string, RejectResult> = {}) {
    this.results = results;
  }

  async check(url: string): Promise<RejectResult | null> {
    this.calls.push(url);
    return this.results[url] ?? null;
  }
}

function renderInput(
  fetcher: FetcherPort,
  overrides: Partial<{ url: string; maxBytes: number; timeoutMs: number }> = {},
) {
  return {
    url: overrides.url ?? "https://public.test/",
    maxBytes: overrides.maxBytes ?? 4096,
    timeoutMs: overrides.timeoutMs ?? 100,
    maxHops: 5,
    fetcher,
  };
}

function request(url: string, resourceType: string, navigation = false, mainFrame = true): ScriptedRequest {
  return { url, resourceType, navigation, mainFrame, method: "GET" };
}

function fetchResult(html: string, finalUrl: string): FetcherResult {
  const bytes = new TextEncoder().encode(html);
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    contentType: "text/html; charset=utf-8",
    bytes: bytes.byteLength,
  };
}

test("createRenderer degrades to render-unavailable with no hosted browser workload", async () => {
  // Hosted never launches an in-process browser (threat model): no CDP workload =>
  // render-unavailable, NOT an in-process launch (which would be render_error when
  // no browser binary is present, e.g. the published gateway image).
  const prevFlavor = process.env.CAPTATUM_FLAVOR;
  const prevCdp = process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
  process.env.CAPTATUM_FLAVOR = "hosted";
  delete process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
  try {
    const renderer = createRenderer();
    const out = await renderer.render(renderInput(new FakeFetcher()));
    assert.equal(out.rendered, false);
    assert.equal((out as { code?: string }).code, "render_unavailable");
  } finally {
    if (prevFlavor === undefined) delete process.env.CAPTATUM_FLAVOR;
    else process.env.CAPTATUM_FLAVOR = prevFlavor;
    if (prevCdp === undefined) delete process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
    else process.env.CAPTATUM_BROWSER_CDP_ENDPOINT = prevCdp;
  }
});

test("essential render pool is a fixed 48MB budget, DECOUPLED from per-response maxBytes (#143)", () => {
  // Heavy SPAs (Notion ~19MB: UISpacePermissionGroupToken 3.7MB + 1.1MB getAppConfig + RecordMap/mainApp/…)
  // ship far more essential JS than one response. Coupling the pool to maxBytes (3×=15MB) aborted those
  // bundles mid-load → render_empty — recurring (cerebralvalley→Cursor/Jira→Notion) each time a heavier
  // SPA crossed the coupled cap. 48MB ≈ 2.5× today's heaviest measured SPA; per-response maxBytes,
  // always-blocked media, + render timeoutMs remain the DoS bounds. Non-essential (CSS etc.) = maxBytes.
  assert.equal(ESSENTIAL_RENDER_BYTES, 48 * 1024 * 1024);
});

test("default post-load settle is 5000ms (raised from 3000 for slow-hydrating docs SPAs) (#110)", () => {
  // Both the networkidle wait and the content-stability dwell return EARLY once stable, so the
  // cap only adds latency for pages not yet stable at 3000ms. Pin the default against regressions.
  const renderer = new PlaywrightRenderer() as PlaywrightRenderer & { settleMs: number };
  assert.equal(renderer.settleMs, 5000);
});

test("renderer skips networkidle (never timeout:0) when the reserved settle cap is 0 (codex P1)", async () => {
  // With timeoutMs <= settleMinDwellMs the reserved networkidle cap is 0. Playwright treats
  // timeout:0 as no-timeout, so passing it would hang a page that never reaches networkidle — the
  // guard skips the wait instead. timeoutMs:100 (the renderInput default) lands networkidleCap at 0.
  const harness = new BrowserHarness();
  await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { timeoutMs: 100 }));
  const networkidle = harness.loadStateCalls.filter((c) => c.state === "networkidle");
  assert.equal(networkidle.length, 0, "networkidle skipped when the reserved cap is 0");
  assert.ok(harness.loadStateCalls.every((c) => (c.timeout ?? 0) > 0), "no timeout:0 passed (would disable the timeout)");
});
