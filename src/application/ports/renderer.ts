import type { FetcherPort, FetcherResult, RejectResult } from "./fetcher.ts";
import type { ProvenanceError } from "../../domain/result.ts";

export interface RenderInput {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxHops: number;
  fetcher: FetcherPort;
  /** Optional abort signal (e.g. the captatum_bulk wall deadline). When it fires, the renderer
   *  CANCELS the in-flight render (closes the page) so an abandoned render cannot keep acquiring
   *  a browser slot + egressing subresources after the bulk returns (codex R4 P2). Additive. */
  signal?: AbortSignal;
}

export type RenderActionType =
  | "service-workers-disabled"
  | "resource-aborted"
  | "request-blocked"
  | "websocket-closed"
  | "download-blocked"
  | "popup-closed"
  | "request-forwarded-post";

export interface RenderAction {
  type: RenderActionType;
  /** Optional for forwarded actions (a forwarded POST has no abort reason); required for blocks. */
  reason?: string;
  url?: string;
  resourceType?: string;
  /** Outcome of the action — defaults to "block" for back-compat (#111 provenance for forwards). */
  outcome?: "ok" | "block";
  /** Provenance for a forwarded POST (request-forwarded-post): the page-authored egress. */
  method?: string;
  bodyBytes?: number;
  responseBytes?: number;
}

export interface RenderSuccess {
  rendered: true;
  fetchResult: FetcherResult;
  actions: RenderAction[];
  /**
   * Advisory provenance note for a successful-but-degraded render (e.g. the
   * rendered HTML exceeded the byte cap and was truncated rather than rejected).
   * Surfaced into Result.errors by the use case; non-fatal.
   */
  notice?: ProvenanceError;
  /** Total network egress for the render (every fulfilled subresource's bytes).
   *  Surfaced as `Result.egressBytes` (BULK-5) — distinct from `fetchResult.bytes`
   *  (the rendered DOM size). */
  egressBytes?: number;
  /** Registrable domains the render loaded subresources from. Fed into the bulk
   *  per-host union count gate as `Result.renderEgressHosts` (BULK-3). */
  egressHosts?: string[];
  /** The browser's LIVE DOM text length (document.body.innerText.length) — captures shadow-DOM /
   *  computed-visible text the serialized-HTML extractor misses. Surfaced as
   *  `RenderDiagnostics.domTextLength` (#154). Absent when the page is gone (best-effort). */
  domTextLength?: number;
}

export type RenderFailure = RejectResult & {
  rendered: false;
  actions: RenderAction[];
  /** Partial Tier-3 network egress before the failure (every subresource fulfilled up to the
   *  fatal error/timeout). Surfaced so a render that loads subresources then fails still counts
   *  its real egress (codex R2 P2). */
  egressBytes?: number;
  /** Partial render egress hosts before the failure (for the per-host union count gate). */
  egressHosts?: string[];
};

export type RenderOutput = RenderSuccess | RenderFailure;

/** Tier-3 render seam. Concrete browser code lives outside the application layer. */
export interface RenderPort {
  render(input: RenderInput): Promise<RenderOutput>;
}
