import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../../src/application/ports/fetcher.ts";
import { PlaywrightRenderer } from "../../src/infrastructure/render/index.ts";

/**
 * Tier-3 popup-egress regression. `page.route` covers only the render page and
 * its frames: a `window.open` / `target=_blank` popup is a NEW target whose
 * requests egress browser-direct, bypassing the guarded FetcherPort entirely
 * (adversarial assessment 2026-08-15: 5 uninstrumented connections incl. a
 * loopback navigation from a non-loopback opener). The renderer now intercepts
 * at the CONTEXT level and closes popups on sight — this test asserts the
 * security property end-to-end with a real Chromium: a hostile page's popups
 * must produce ZERO connections the instrumented fetcher never made.
 *
 * Auto-skips when Chromium is unavailable (same probe as fixtures.test.ts).
 */
let chromiumReady = false;
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  chromiumReady = true;
} catch {
  chromiumReady = false;
}

describe("Tier-3 popup egress (real Chromium)", { skip: !chromiumReady }, () => {
  let hits: Array<{ url: string }> = [];
  let server: http.Server;
  let port = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? "" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>popup</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("window.open / target=_blank / iframe probes never egress browser-direct", async () => {
    const popupUrl = `http://127.0.0.1:${port}/popup-windowopen`;
    const anchorUrl = `http://127.0.0.1:${port}/popup-anchor`;
    const calls: string[] = [];
    // The instrument: every guarded fetch lands here. It serves the main page;
    // the popup URLs point at the REAL local server — the escape detector.
    const fetcher: FetcherPort = {
      async fetchGuarded(url: string, _opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
        calls.push(url);
        const isMain = url === "http://mainpage.test/";
        const body = isMain
          ? `<html><head><script src="http://mainpage.test/app.js"></script><script>
              window.addEventListener('load', () => {
                try { window.open(${JSON.stringify(popupUrl)}, "_p1"); } catch (e) {}
                try { const a = document.createElement('a'); a.href = ${JSON.stringify(anchorUrl)}; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); } catch (e) {}
                try { const f = document.createElement('iframe'); f.src = ${JSON.stringify(`http://127.0.0.1:${port}/iframe-probe`)}; document.body.appendChild(f); } catch (e) {}
              });
            </script></head><body>main</body></html>`
          : "<html><body>stub-ok</body></html>";
        const bytes = new TextEncoder().encode(isMain ? body : (url.endsWith("app.js") ? "console.log(1)" : body));
        return {
          status: 200, finalUrl: url, redirects: [],
          bodyStream: new Blob([bytes]).stream(),
          contentType: isMain ? "text/html; charset=utf-8" : (url.endsWith("app.js") ? "application/javascript" : "text/html; charset=utf-8"),
          bytes: bytes.byteLength,
        };
      },
    };

    // positive control: the detector answers a direct client of our own
    const ctrl = await fetch(`http://127.0.0.1:${port}/positive-control`);
    assert.equal(ctrl.status, 200);
    const baseline = hits.length;

    const renderer = new PlaywrightRenderer({ chromiumSandbox: true });
    const out = await renderer.render({
      url: "http://mainpage.test/", maxBytes: 2 * 1024 * 1024, timeoutMs: 20000, maxHops: 5, fetcher,
    });
    // let any late popup sub-fetch settle before judging
    await new Promise((r) => setTimeout(r, 1500));

    if (calls.length === 0) {
      // CI-only failure diagnosis (passes locally deterministically): dump
      // everything the renderer observed so the log shows WHY interception
      // never ran — render outcome, code/message, and the action log.
      console.error("POPUP-EGRESS DIAGNOSIS:", JSON.stringify({
        rendered: out.rendered,
        code: out.code,
        message: out.message?.slice(0, 300),
        actions: (out.actions ?? []).slice(0, 8),
        calls,
      }));
    }
    assert.ok(calls.length > 0, "instrumented fetcher must have fired (main navigation)");
    const escaped = hits.slice(baseline);
    assert.deepEqual(
      escaped.map((h) => h.url),
      [],
      `browser-direct egress detected (popups escaped interception): ${JSON.stringify(escaped)}`,
    );
    assert.ok(
      (out.actions ?? []).some((a) => a.type === "popup-closed"),
      "popup close action must be recorded",
    );
  });
});
