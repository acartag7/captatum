// Render-lifetime abort for single-fetch renders. Executed 2026-09-01 (Level-3
// re-walk, shipped image): the tool result returned at 2.7 s while a guarded
// subresource fetch kept streaming until its OWN timeoutMs (~5 s) — single-fetch
// renders composed no signal into the route fulfiller, so egress + a fetch slot
// outlived the returned result by up to ~timeoutMs. The bulk wall already threads
// a signal (codex R6 P2); this gives single-fetch the same lifecycle: every
// subresource fetchGuarded composes an AbortController that fires in render()'s
// finally. Spec: docs/threat-model.md §"Tier-3 in-browser SSRF".

import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaywrightRenderer } from "../src/infrastructure/render/index.ts";
import type { FetcherPort } from "../src/application/ports/fetcher.ts";
import type { PlaywrightModule } from "../src/infrastructure/render/playwright-types.ts";

test("single-fetch render aborts in-flight subresource fetches when the render ends", async () => {
  const capturedSignals: Array<AbortSignal | undefined> = [];
  const fetcher: FetcherPort = {
    async fetchGuarded(_url: string, opts: { signal?: AbortSignal }) {
      capturedSignals.push(opts?.signal);
      // Never settles: models a hung/slow subresource whose connection the abort
      // must tear down. Observed via the signal state after the render returns —
      // no rejection to leak past the test boundary.
      return new Promise<never>(() => {});
    },
  } as unknown as FetcherPort;

  let routeHandler: ((route: unknown) => void | Promise<void>) | undefined;
  const fakeRoute = {
    request: () => ({
      method: () => "GET",
      url: () => "https://a.test/sub.js",
      postDataBuffer: null,
      headers: () => ({}),
      resourceType: () => "fetch",
      frame: () => ({}),
    }),
    fulfill: async () => {},
    abort: async () => {},
  };
  const context = {
    newPage: async () => page,
    route: async (_pat: string, handler: (route: unknown) => void) => { routeHandler = handler as never; },
    on: () => {},
    routeWebSocket: async () => {},
    close: async () => {},
  };
  const page = {
    mainFrame: () => ({}),
    frames: () => [],
    goto: async () => {
      void routeHandler?.(fakeRoute); // the page fires one subresource mid-navigation
      return { status: () => 200 };
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    content: async () => "<html><body><main>content</main></body></html>",
    evaluate: async () => "stable",
    url: () => "https://a.test/1",
    close: async () => {},
    on: () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  };
  const mod = {
    chromium: {
      launch: async () => ({ newContext: async () => context, close: async () => {} }),
    },
  } as unknown as PlaywrightModule;
  const guard = { check: async () => null }; // every subresource passes the URL guard
  const renderer = new PlaywrightRenderer({ loadPlaywright: async () => mod, guard: guard as never });

  const out = await renderer.render({
    url: "https://a.test/1",
    maxBytes: 4096,
    timeoutMs: 3000,
    maxHops: 5,
    fetcher,
  } as never);

  assert.equal(out.rendered, true, "render itself succeeds");
  assert.equal(capturedSignals.length, 1, "the subresource fetch reached the guarded fetcher");
  assert.equal(
    capturedSignals[0]?.aborted ?? false,
    true,
    "the subresource fetch's signal must be aborted once the render result is returned",
  );
});
