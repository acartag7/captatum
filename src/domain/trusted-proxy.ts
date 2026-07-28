import { isIP } from "node:net";

const MAX_TRUSTED_PROXIES = 32;

/** Parse the hosted reverse-proxy trust boundary as a closed IP/CIDR allowlist. */
export function parseTrustedProxyCidrs(raw: string): string[] {
  if (raw.trim() === "") {
    throw new Error("CAPTATUM_TRUSTED_PROXY_CIDRS is required for hosted HTTP");
  }
  const entries = raw.split(",").map((entry) => entry.trim());
  if (
    entries.length > MAX_TRUSTED_PROXIES
    || entries.some((entry) => entry === "")
  ) {
    throw invalidTrustedProxy();
  }
  const unique = new Set<string>();
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const prefix = slash === -1 ? undefined : entry.slice(slash + 1);
    const family = isIP(address);
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    const minPrefix = family === 4 ? 24 : family === 6 ? 64 : -1;
    if (
      family === 0
      || prefix !== undefined && (
        prefix === ""
        || !/^(0|[1-9][0-9]{0,2})$/.test(prefix)
        || Number(prefix) < minPrefix
        || Number(prefix) > maxPrefix
      )
      || slash !== -1 && entry.indexOf("/", slash + 1) !== -1
      || unique.has(entry)
    ) throw invalidTrustedProxy();
    unique.add(entry);
  }
  return [...unique];
}

function invalidTrustedProxy(): Error {
  return new Error(
    "CAPTATUM_TRUSTED_PROXY_CIDRS must be a comma-separated allowlist of unique IP addresses or narrow CIDRs (IPv4 /24-/32; IPv6 /64-/128)",
  );
}
