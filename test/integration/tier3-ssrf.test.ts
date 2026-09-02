/**
 * Tier-3 browser SSRF — REAL Chromium regression suite for TIER3-SSRF-1/2/NAV-1.
 *
 * Drives a real Chromium through PlaywrightRenderer with an injected stub
 * FetcherPort — no real DNS or network required. The renderer fulfills every
 * non-aborted request through the fetcher (route.fulfill, never route.continue),
 * so the browser makes ZERO direct egress: each URL it requests is resolved
 * (once) and every redirect hop re-validated by the fetcher. DNS-rebinding and
 * the continue()-redirect TOCTOU are therefore structurally eliminated, and the
 * browser's own redirect FSM is removed from the egress path.
 *
 * The rebinding/redirect outcomes are modeled by the stub, which stands in for
 * fetchGuarded's resolve-once + per-hop private-IP revalidation. A real-DNS
 * rebind is not needed: the invariant under test is that the browser can only
 * ever see bytes the fetcher returns, so a rejected URL can never execute.
 *
 * Auto-skips when Chromium is unavailable. Run: node --test test/integration/tier3-ssrf.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  FetcherPort,
  FetcherResult,
  RejectResult,
} from "../../src/application/ports/fetcher.ts";
import type { RenderOutput } from "../../src/application/ports/renderer.ts";
import { PlaywrightRenderer } from "../../src/infrastructure/render/index.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const chromiumReady = await probeChromium();
const skipReason = chromiumReady ? false : "Chromium unavailable — run `npx playwright install chromium`";

describe("Tier-3 SSRF — every browser request routes through the fetcher (real Chromium)", () => {
  test("rebinding subresource is resolved once by the fetcher and blocked; a legit script still runs", {
    skip: skipReason,
    timeout: 60_000,
  }, async () => {
    const pageUrl = "https://test-render.local/";
    const legitScriptUrl = "https://legit-cdn.test/widget.js";
    const rebindScriptUrl = "https://rebind.attacker.test/exfil.js";
    const pageHtml = `<!doctype html><html><body>
      <p>main page content marker</p>
      <script src="${legitScriptUrl}"></script>
      <script src="${rebindScriptUrl}"></script>
    </body></html>`;
    const legitJs = `document.body.setAttribute("data-legit","RAN");`;
    const fetcher = stubFetcher((url) => {
      if (url === pageUrl) return html(pageHtml, pageUrl);
      if (url === legitScriptUrl) return js(legitScriptUrl, legitJs);
      if (url.startsWith("https://rebind.attacker.test/")) {
        // fetchGuarded resolved this "public-first" host to a private IP at its
        // single resolve and rejected — exactly the rebinding TOCTOU a
        // name-only continue() guard loses (the browser never gets a 2nd lookup).
        return reject("private_address", "Host resolves to a private or reserved address");
      }
      return reject("unexpected_url", `unexpected request ${url}`);
    });

    const out = await render(pageUrl, fetcher);
    assert.equal(out.rendered, true, `render failed: ${out.rendered === false ? out.code : ""}`);
    // Both subresources were intercepted and routed through the fetcher — the
    // browser never connected to either host itself.
    assert.ok(fetcher.calls.includes(rebindScriptUrl), "rebinding subresource routed through the fetcher");
    assert.ok(fetcher.calls.includes(legitScriptUrl), "legit subresource routed through the fetcher");
    const text = await bodyText(out);
    assert.match(text, /main page content marker/, "main content rendered");
    assert.match(text, /data-legit="RAN"/, "the fetcher-fulfilled legit script executed");
    assert.doesNotMatch(text, /REBIND_LEAK/, "the rejected rebinding script never executed");
    assert.ok(
      out.actions.some((a) => a.type === "request-blocked" && a.reason === "private_address" && (a.url ?? "").includes("rebind.attacker.test")),
      "a private_address block action was recorded for the rebinding request",
    );
  });

  test("navigation that (via the fetcher) redirects to a private host fails closed — no content captured", {
    skip: skipReason,
    timeout: 60_000,
  }, async () => {
    const navUrl = "https://redirect.test/start";
    const fetcher = stubFetcher(() =>
      // fetchGuarded followed the 302 internally and hit a private IP at the
      // redirect hop; the browser never observes the redirect, so Playwright's
      // continue-redirect FSM (TIER3-NAV-1) is entirely out of the egress path.
      reject("private_address", "Redirect target resolves to a private or reserved address"),
    );

    const out = await render(navUrl, fetcher);
    assert.equal(out.rendered, false);
    assert.equal(out.code, "private_address");
  });

  test("sanity: a normal page renders through the fetcher (fulfillment does not break legit rendering)", {
    skip: skipReason,
    timeout: 60_000,
  }, async () => {
    const pageUrl = "https://plain.test/";
    const fetcher = stubFetcher((url) =>
      url === pageUrl
        ? html("<html><body><p>rendered body text</p></body></html>", pageUrl)
        : reject("unexpected_url", `unexpected request ${url}`),
    );
    const out = await render(pageUrl, fetcher);
    assert.equal(out.rendered, true);
    assert.match(await bodyText(out), /rendered body text/);
  });
});

async function render(url: string, fetcher: FetcherPort): Promise<RenderOutput> {
  // chromiumSandbox off: CI Linux runners can't run Chromium's setuid sandbox —
  // the sibling suites (fixtures, popup-egress) launch the same way; prod keeps it on.
  return new PlaywrightRenderer({ chromiumSandbox: false }).render({
    url,
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    maxHops: 5,
    fetcher,
  });
}

async function bodyText(out: RenderOutput): Promise<string> {
  if (!out.rendered) throw new Error(`expected render success, got ${out.code}`);
  return new Response(out.fetchResult.bodyStream).text();
}

type StubHandler = (url: string) => FetcherResult | RejectResult;

class StubFetcher implements FetcherPort {
  readonly calls: string[] = [];
  private readonly handle: StubHandler;

  constructor(handle: StubHandler) {
    this.handle = handle;
  }

  async fetchGuarded(url: string): Promise<FetcherResult | RejectResult> {
    this.calls.push(url);
    return this.handle(url);
  }
}

function stubFetcher(handle: StubHandler): StubFetcher & { calls: string[] } {
  return new StubFetcher(handle);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function html(body: string, finalUrl: string): FetcherResult {
  return result(body, finalUrl, "text/html; charset=utf-8");
}

function js(finalUrl: string, code: string): FetcherResult {
  return result(code, finalUrl, "text/javascript");
}

function result(body: string, finalUrl: string, contentType: string): FetcherResult {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: streamOf(bytes),
    contentType,
    bytes: bytes.byteLength,
  };
}

function reject(code: string, message: string): RejectResult {
  return { rejected: true, code, message };
}

async function probeChromium(): Promise<boolean> {
  try {
    const playwright = await import("playwright") as unknown as {
      chromium: { launch(options?: Record<string, unknown>): Promise<{ close(): Promise<void> }> };
    };
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
