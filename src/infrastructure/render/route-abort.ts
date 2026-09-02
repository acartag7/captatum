/** Route-abort helper extracted from RenderRouteState for the 250-line cap.
 * Post-teardown aborts (render-lifetime cleanup) satisfy the browser but stay
 * OUT of provenance — a teardown cancellation is not a request-blocked action. */
import type { RenderAction } from "../../application/ports/renderer.ts";
import { safeRenderUrl } from "./browser-url-guard.ts";
import type { PlaywrightRoute } from "./playwright-types.ts";

export async function abortRoute(
  route: PlaywrightRoute,
  opts: {
    actions: RenderAction[];
    teardown: boolean;
    url: string;
    resourceType: string;
    reason: string;
    type?: RenderAction["type"];
  },
): Promise<void> {
  if (!opts.teardown) {
    opts.actions.push({
      type: opts.type ?? "request-blocked",
      reason: opts.reason,
      url: safeRenderUrl(opts.url),
      resourceType: opts.resourceType,
    });
  }
  await route.abort("blockedbyclient");
}
