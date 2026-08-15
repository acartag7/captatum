import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Resolve the allowlisted CDP Service origin to the IP form Playwright must
 * connect over. Chromium's DevTools HTTP server rejects requests whose Host
 * header is neither an IP literal nor localhost (DNS-rebinding protection,
 * net/http_handler) with a bare 500 — so `connectOverCDP` against the Service
 * DNS name fails at /json/version even though the relay forwards the bytes
 * fine. The configured endpoint keeps its validated
 * `<service>.<namespace>.svc.cluster.local` shape (config.parseCdpEndpoint,
 * unchanged trust boundary); only the CONNECT URL swaps the hostname for the
 * address it resolves to right now, so the Host header Chromium sees is an IP
 * and kube-proxy still load-balances through the same ClusterIP.
 */
export type CdpHostResolver = (hostname: string) => Promise<string>;

export const dnsCdpHostResolver: CdpHostResolver = async (hostname) => {
  const { address } = await lookup(hostname);
  return address;
};

/** Map the validated CDP endpoint origin to the URL Playwright should dial. */
export async function resolveCdpConnectUrl(
  endpoint: string,
  resolve: CdpHostResolver = dnsCdpHostResolver,
): Promise<string> {
  const parsed = new URL(endpoint);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0 || hostname === "localhost") return endpoint;
  const address = await resolve(hostname);
  parsed.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return parsed.origin;
}
