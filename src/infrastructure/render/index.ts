import { config } from "../../config.ts";
import type { RenderPort } from "../../application/ports/renderer.ts";
import { PlaywrightRenderer } from "./playwright-renderer.ts";

export { PlaywrightRenderer } from "./playwright-renderer.ts";
export type { PlaywrightRendererDeps } from "./playwright-renderer.ts";
export { P1BrowserUrlGuard } from "./browser-url-guard.ts";
export type { BrowserUrlGuard } from "./browser-url-guard.ts";

/**
 * Pick the renderer from config: a CDP sidecar (browser in its own container —
 * the secure hosted path) or an in-process launch (local-binary path, sandbox
 * on by default). The browser/SSRF blast radius must not run in-process with the
 * hosted gateway — see docs/threat-model.md. The renderer is wrapped in a
 * render-concurrency limiter (DOS-2): Chromium is the expensive resource, so
 * concurrent Tier-3 renders are bounded independently of the global admission cap.
 */
export function createRenderer(
  cdpEndpoint = config.render.cdpEndpoint(),
): RenderPort {
  // Hosted never launches a browser in-process (threat model): without a CDP
  // sidecar, Tier-3 is render-unavailable rather than attempting an in-process
  // launch inside the OAuth-key blast radius. The published gateway image ships no
  // browser binary anyway. Local-binary keeps the in-process path (sandbox on).
  if (config.deployment.flavor() === "hosted" && !cdpEndpoint) {
    return limitRenderConcurrency(unavailableRenderer(), config.render.maxConcurrentRenders());
  }
  const inner = cdpEndpoint
    ? new PlaywrightRenderer({ cdpEndpoint })
    : new PlaywrightRenderer({ chromiumSandbox: config.render.chromiumSandbox() });
  return limitRenderConcurrency(inner, config.render.maxConcurrentRenders());
}

/** A renderer that always reports Tier-3 unavailable — used when the hosted
 *  gateway has no CDP sidecar configured (no in-process browser in hosted). */
function unavailableRenderer(): RenderPort {
  return {
    async render() {
      return {
        rejected: true,
        rendered: false,
        code: "render_unavailable",
        message: "Hosted gateway has no browser (set CAPTATUM_BROWSER_CDP_ENDPOINT to a sidecar for Tier-3)",
        actions: [],
      };
    },
  };
}

/** DOS-2: a FIFO semaphore bounding concurrent render() calls. A caller over the
 * cap awaits a slot; the slot is released in finally so a failed render does not
 * permanently consume it. max < 1 disables limiting (passthrough). */
function limitRenderConcurrency(inner: RenderPort, max: number): RenderPort {
  if (max < 1) return inner;
  let running = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => { running -= 1; const next = waiters.shift(); if (next) next(); };
  return {
    async render(input) {
      while (running >= max) await new Promise<void>((resolve) => { waiters.push(resolve); });
      running += 1;
      try { return await inner.render(input); } finally { release(); }
    },
  };
}
