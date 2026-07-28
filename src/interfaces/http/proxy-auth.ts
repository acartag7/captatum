import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const PROXY_AUTH_HEADER = "x-captatum-proxy-auth";
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "cf-connecting-ip",
] as const;

export type ProxyHeaderDecision = "authenticated" | "direct" | "reject";

/**
 * Authenticate the edge-added forwarding envelope and remove its bearer secret
 * before any route, audit, or error path can observe it.
 */
export function authenticateProxyHeaders(
  headers: IncomingHttpHeaders,
  distinctHeaders: NodeJS.Dict<string[]> | undefined,
  rawHeaders: string[],
  expectedSecret: string,
): ProxyHeaderDecision {
  const supplied = headers[PROXY_AUTH_HEADER];
  removeHeaderViews(
    headers,
    distinctHeaders,
    rawHeaders,
    PROXY_AUTH_HEADER,
  );
  const hasForwarding = FORWARDED_HEADERS.some(
    (header) => headers[header] !== undefined,
  );
  if (supplied === undefined && !hasForwarding) return "direct";
  if (!secretMatches(supplied, expectedSecret)) {
    for (const header of FORWARDED_HEADERS) {
      removeHeaderViews(headers, distinctHeaders, rawHeaders, header);
    }
    return "reject";
  }
  return "authenticated";
}

function removeHeaderViews(
  headers: IncomingHttpHeaders,
  distinctHeaders: NodeJS.Dict<string[]> | undefined,
  rawHeaders: string[],
  name: string,
): void {
  delete headers[name];
  if (distinctHeaders !== undefined) delete distinctHeaders[name];
  for (let index = rawHeaders.length - 2; index >= 0; index -= 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      rawHeaders.splice(index, 2);
    }
  }
}

function secretMatches(
  supplied: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof supplied !== "string") return false;
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}
