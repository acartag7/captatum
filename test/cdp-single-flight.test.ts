// Single-flight CDP connect: concurrent FIRST renders must share one connectOverCDP
// promise. Executed 2026-09-01 (Level-3 re-walk, shipped-image topology): a 3-way
// concurrent first-render race left TWO established connections on the browser pod's
// relay (cap 32) — the winner was cached, the loser's WebSocket leaked permanently
// (persisted through later renders, not GC-closed). The deadline-race path had its
// late-arrival cleanup (codex P2 r2); this winner-overwrites-loser path is the
// unmirrored sibling. Spec: docs/threat-model.md (Tier-3 sandbox model, relay cap).

import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaywrightRenderer } from "../src/infrastructure/render/index.ts";
import type { FetcherPort } from "../src/application/ports/fetcher.ts";
import type { PlaywrightModule } from "../src/infrastructure/render/playwright-types.ts";

const fetcher: FetcherPort = {
  async fetchGuarded() {
    throw Object.assign(new Error("unused"), { code: "network_error" });
  },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://attacker.test/page",
    maxBytes: 1024,
    timeoutMs: 5000,
    maxHops: 5,
    fetcher,
    ...overrides,
  };
}

function fakePlaywright(connectDelayMs: number, counter: { calls: number }) {
  const failingAfterConnect = {
    newContext: async () => { throw new Error("context boom (post-connect)"); },
  };
  const mod = {
    chromium: {
      // NOT awaited until connectDelayMs elapses — two concurrent renders both
      // enter the connect path before either resolves (the race window).
      connectOverCDP: async () => {
        counter.calls += 1;
        await new Promise((r) => setTimeout(r, connectDelayMs));
        return failingAfterConnect as never;
      },
    },
  } as unknown as PlaywrightModule;
  return mod;
}

test("concurrent first renders share one connectOverCDP (no leaked relay connection)", async () => {
  const counter = { calls: 0 };
  const mod = fakePlaywright(30, counter);
  const renderer = new PlaywrightRenderer({
    loadPlaywright: async () => mod,
    cdpEndpoint: "http://chromium.captatum.svc.cluster.local:9222",
    cdpResolver: async () => "127.0.0.1",
  });
  const results = await Promise.allSettled([
    renderer.render(input({ url: "https://a.test/1" }) as never),
    renderer.render(input({ url: "https://a.test/2" }) as never),
    renderer.render(input({ url: "https://a.test/3" }) as never),
  ]);
  // All three fail AFTER the shared connect (context boom) — the failure mode is
  // irrelevant; the connect count is the assertion.
  assert.ok(results.every((r) => r.status === "rejected" || r.status === "fulfilled"));
  assert.equal(counter.calls, 1, `expected exactly ONE connectOverCDP, saw ${counter.calls}`);
});

test("sequential renders after a successful connect reuse the cached browser", async () => {
  const counter = { calls: 0 };
  const context = {
    newPage: async () => ({
      mainFrame: {},
      frames: () => [],
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      content: async () => "<html><body><main>hi</main></body></html>",
      url: () => "https://a.test/1",
      mainFrame: () => ({}),
      evaluate: async () => "stable dom text",
      waitForTimeout: async () => {},
      close: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      on: () => {},
    }),
    route: async () => {},
    on: () => {},
    routeWebSocket: async () => {},
    close: async () => {},
  };
  const mod = {
    chromium: {
      connectOverCDP: async () => {
        counter.calls += 1;
        return { newContext: async () => context, close: async () => {} } as never;
      },
    },
  } as unknown as PlaywrightModule;
  const renderer = new PlaywrightRenderer({
    loadPlaywright: async () => mod,
    cdpEndpoint: "http://chromium.captatum.svc.cluster.local:9222",
    cdpResolver: async () => "127.0.0.1",
  });
  const first = await renderer.render(input() as never);
  const second = await renderer.render(input() as never);
  assert.equal(counter.calls, 1, "second render must reuse the cached CDP browser");
  assert.equal(first.rendered, true);
  assert.equal(second.rendered, true);
});

test("a short-budget waiter fails on its OWN deadline, not the initiator's", async () => {
  const counter = { calls: 0 };
  const mod = fakePlaywright(120, counter); // slow connect, then context boom
  const renderer = new PlaywrightRenderer({
    loadPlaywright: async () => mod,
    cdpEndpoint: "http://chromium.captatum.svc.cluster.local:9222",
    cdpResolver: async () => "127.0.0.1",
  });
  const t = Date.now();
  const slow = renderer.render(input({ url: "https://a.test/slow", timeoutMs: 10000 }) as never);
  const fast = renderer.render(input({ url: "https://a.test/fast", timeoutMs: 30 }) as never);
  const [slowOut, fastOut] = await Promise.allSettled([slow, fast]);
  const wall = Date.now() - t;
  assert.equal(fastOut.status, "fulfilled", "fast render must settle (as a failure), not hang");
  const fastResult = fastOut.value as { rendered: boolean; code?: string };
  assert.equal(fastResult.rendered, false);
  assert.equal(fastResult.code, "timeout", "withTimeout rejects with its timeout code at the waiter's own budget");
  assert.ok(wall < 2000, `fast waiter should fail near its own 30ms budget (wall ${wall}ms)`);
  assert.ok(counter.calls >= 1, "the shared attempt ran");
  void slowOut;
});

test("a stalled shared connect detaches when its waiters expire — recovery needs no restart (codex round)", async () => {
  // First connectOverCDP NEVER settles (stalled resolver); a render times out on its own
  // budget; the slot must detach so a SECOND render starts a fresh attempt and succeeds.
  let calls = 0;
  const context = {
    newPage: async () => ({
      mainFrame: () => ({}), frames: () => [], goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {}, waitForTimeout: async () => {},
      content: async () => "<html><body><main>x</main></body></html>",
      evaluate: async () => "s", url: () => "https://a.test/1", close: async () => {},
      on: () => {}, setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    }),
    route: async () => {}, on: () => {}, routeWebSocket: async () => {}, close: async () => {},
  };
  const mod = {
    chromium: {
      connectOverCDP: async () => {
        calls += 1;
        if (calls === 1) return await new Promise<never>(() => {}); // stalled forever
        return { newContext: async () => context, close: async () => {} } as never;
      },
    },
  } as unknown as PlaywrightModule;
  const renderer = new PlaywrightRenderer({
    loadPlaywright: async () => mod,
    cdpEndpoint: "http://chromium.captatum.svc.cluster.local:9222",
    cdpResolver: async () => "127.0.0.1",
  });
  const first = await renderer.render(input({ url: "https://a.test/stall", timeoutMs: 60 }) as never);
  assert.equal(first.rendered, false, "stalled connect must fail on the render's own budget");
  await new Promise((r) => setTimeout(r, 30));
  const second = await renderer.render(input({ url: "https://a.test/ok", timeoutMs: 5000 }) as never);
  assert.equal(second.rendered, true, "a fresh attempt must run after the stalled slot detaches");
  assert.equal(calls, 2, "exactly one fresh connect after detach");
});
