import { isLoopbackHost } from "./domain/policy.ts";
import { BULK_GUARD_CEILINGS } from "./domain/bulk-policy.ts";
import {
  parseProxyAuthSecret,
  parseTrustedProxyCidrs,
} from "./domain/trusted-proxy.ts";
import {
  envBulkWallMs,
  envList,
  envStrictBoolean,
  envStrictInteger,
  envString,
} from "./env-parsing.ts";

const DNS_1123_LABEL =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const config = {
  source: {
    maxFileLines: 250,
  },
  http: {
    host: () => envString("HOST", "127.0.0.1"),
    port: () => envStrictInteger("PORT", 3000, 65535),
    bodyLimitBytes: 5 * 1024 * 1024,
  },
  mcp: {
    endpointPath: "/mcp",
    stableProtocolVersion: "2025-11-25",
    forwardDesignVersion: "2026-07-28",
    allowedHosts: () => envList("MCP_ALLOWED_HOSTS"),
    allowedOrigins: () => envList("MCP_ALLOWED_ORIGINS"),
    trustedProxyCidrs: () => parseTrustedProxyCidrs(
      envString("CAPTATUM_TRUSTED_PROXY_CIDRS", ""),
    ),
    proxyAuthSecret: () => parseProxyAuthSecret(
      envString("CAPTATUM_PROXY_AUTH_SECRET", ""),
    ),
    /** #45: "clientId=profile,..." mapping for client-aware output shaping (parsed by
     *  src/application/client-profile.ts). Unknown clientIds → the default shape. */
    clientProfiles: () => envString("CAPTATUM_CLIENT_PROFILES", ""),
  },
  cloudflareAccess: {
    enabled: () => envString("CF_ACCESS_ENABLED", "false") === "true",
    audience: () => envString("CF_ACCESS_AUDIENCE", ""),
    certsUrl: () => envString("CF_ACCESS_CERTS_URL", ""),
    issuer: () => envString("CF_ACCESS_ISSUER", ""),
    /** #9: optional defense-in-depth email allowlist for the CF Access JWT verifier.
     *  Empty (default) delegates WHO is allowed to the CF Zero Trust app policy. */
    emailAllowlist: () => envList("CF_ACCESS_EMAIL_ALLOWLIST"),
  },
  deployment: {
    flavor: () => envString("CAPTATUM_FLAVOR", envString("DEPLOYMENT_FLAVOR", "local-binary")),
    production: () => envString("NODE_ENV", "development") === "production",
  },
  oauth: {
    issuer: () => envString("OAUTH_ISSUER", ""),
    resource: () => envString("OAUTH_RESOURCE", ""),
    consentSigningSecret: () => envString("OAUTH_CONSENT_SIGNING_SECRET", ""),
    signingPrivateJwk: () => envString("OAUTH_SIGNING_PRIVATE_JWK", ""),
    signingKeyId: () => envString("OAUTH_SIGNING_KEY_ID", ""),
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2592000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
    redirectAllowlist: () => envString("OAUTH_REDIRECT_ALLOWLIST", "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  transform: {
    openRouterApiKey: () => envString("OPENROUTER_API_KEY", ""),
    openRouterBaseUrl: () => envString("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    openRouterModels: () => envString(
      "OPENROUTER_MODELS",
      // Primary = deepseek-v4-flash (cheap, 1M context). Fallback = qwen3.6-flash —
      // a DIFFERENT lab (Alibaba) so a DeepSeek upstream outage doesn't take down
      // the fallback too; flash-tier (cheap), 1M context, current (2026-04-27). NOT
      // openrouter/auto (unpredictable routing → garbage) and not a stale model.
      "deepseek/deepseek-v4-flash,qwen/qwen3.6-flash",
    ),
    ollamaBaseUrl: () => {
      const url = envString("OLLAMA_BASE_URL", "");
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
            throw new Error(`OLLAMA_BASE_URL must be https (or loopback): ${url}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("OLLAMA_BASE_URL")) throw e;
          throw new Error(`OLLAMA_BASE_URL is not a valid URL: ${url}`);
        }
      }
      return url;
    },
    ollamaModel: () => envString("OLLAMA_MODEL", "llama3.1"),
    timeoutMs: () => envStrictInteger("TRANSFORM_TIMEOUT_MS", 45_000, 600_000),
    /** #3: default output-token budget when the caller omits `budget` (bounds paid
     *  generation per call). Clamped upstream to the chosen model's max (#125).
     *  Raised 2 000 → 8 000: 2 K was low enough that content-rich pages silently
     *  truncated. */
    maxOutputTokensDefault: () => envStrictInteger("TRANSFORM_MAX_OUTPUT_TOKENS", 8_000, 100_000),
    freeFirst: true,
  },
  render: {
    allowRenderDefault: false,
    timeoutMs: 20000,
    /** CDP origin of the isolated browser workload. Empty disables hosted Tier-3. */
    cdpEndpoint: () => parseCdpEndpoint(
      envString("CAPTATUM_BROWSER_CDP_ENDPOINT", ""),
    ),
    /** Chromium sandbox for in-process launch (default true — threat model: never --no-sandbox). Only relevant when no CDP workload is configured. */
    chromiumSandbox: () => envStrictBoolean("CAPTATUM_BROWSER_INPROCESS_SANDBOX", true),
    /** DOS-2: max concurrent Tier-3 renders. Chromium is the expensive resource, so
     * bound it independently of the global admission cap (default 2). */
    maxConcurrentRenders: () => envStrictInteger("CAPTATUM_MAX_CONCURRENT_RENDERS", 2, 16),
    /** #111: per-render cap on a forwarded POST body (bytes). Never truncates — a body over
     *  the cap is aborted (a half JSON body 400s). 1 MiB accommodates large Notion pages. */
    postMaxBytes: () => envStrictInteger("CAPTATUM_RENDER_POST_MAX_BYTES", 1_048_576, 64 * 1_048_576),
    /** #111: per-render concurrency cap on concurrent first-party POSTs (Chromium's per-origin
     *  limit). A POST over the cap is aborted (tryAcquire, never awaited) as render_concurrency_limit. */
    postConcurrency: () => envStrictInteger("CAPTATUM_RENDER_POST_CONCURRENCY", 6, 64),
  },
  bulk: {
    /** Hosted captatum_bulk gate (BULK-GATE): ON as of PR 3 — the LimitingFetcher
     *  (BULK-2) + BulkQuotaPort (BULK-1) have landed. Local flavor ships ON regardless.
     *  Operators may set this to "false" to disable hosted bulk independently. */
    enabled: () => envString("CAPTATUM_BULK_ENABLED", "true") === "true",
    maxPerHostInflight: () => envStrictInteger("CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT", 2, BULK_GUARD_CEILINGS.maxPerHostInflight),
    crawlDelayMs: () => envStrictInteger("CAPTATUM_BULK_CRAWL_DELAY_MS", 1_000, 600_000),
    maxConcurrency: () => envStrictInteger("CAPTATUM_BULK_MAX_CONCURRENCY", 4, 8),
    /** #157: hosted runtime lever to raise the bulk global-deadline wall (maxGlobalWallMs) from
     *  the 55 s hosted default toward the 180 s hard ceiling, without a code change. The wall is a
     *  directed-DoS / egress-deadline bound, so this is a SECURITY SELECTOR — malformed input fails
     *  CLOSED at boot (throw), never silently falls back (never `value || default`). UNSET / empty /
     *  whitespace-only → undefined (the hosted path omits the field and the domain applies the 55 s
     *  default). A clean decimal integer of ms in [1, ceiling] → that value. Anything else —
     *  non-numeric, zero, above the ceiling, or a Number() shape the operator did not literally type
     *  (hex, scientific, float, signed) — throws, naming the env var + the valid range. The ceiling
     *  is single-sourced from BULK_GUARD_CEILINGS (the domain's hard cap); the domain clamps again
     *  as defense-in-depth. Operator/deploy-time env (k8s ConfigMap/Secret), not request input. */
    maxGlobalWallMs: (): number | undefined => envBulkWallMs("CAPTATUM_BULK_MAX_GLOBAL_WALL_MS"),
    /** BULK-2: process-wide GLOBAL fetch-concurrency cap on hosted (LimitingFetcher).
     *  Bounds the unbounded worst case (admission 8 CALLS × maxConcurrency 4 = up to 32
     *  concurrent fetches) below the 2 vCPU/4 GiB sizing. Default 24: below 32 (bounds the
     *  box) while leaving headroom so single-fetch rarely queues under bulk load. Single-fetch
     *  shares the FIFO pool with bulk seeds — under heavy concurrent bulk load it MAY briefly
     *  queue, bounded by its own timeoutMs (fails gracefully as a retriable `timeout`). */
    globalFetchConcurrency: () => envStrictInteger("CAPTATUM_GLOBAL_FETCH_CONCURRENCY", 24, 128),
    /** BULK-1: per-tenant rolling seed-window quota window length (seconds). */
    quotaWindowSeconds: () => envStrictInteger("CAPTATUM_BULK_QUOTA_WINDOW_SECONDS", 60, 86_400),
    /** BULK-1: per-tenant rolling seed-window quota seed limit (max seeds/window). */
    quotaSeedLimit: () => envStrictInteger("CAPTATUM_BULK_QUOTA_SEED_LIMIT", 300, 10_000),
  },
};

export function parseCdpEndpoint(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CAPTATUM_BROWSER_CDP_ENDPOINT is not a valid URL");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.protocol !== "http:" ||
    parsed.port !== "9222" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !isKubernetesServiceHost(parsed.hostname)
  ) {
    throw new Error("CAPTATUM_BROWSER_CDP_ENDPOINT is not an allowed CDP origin");
  }
  return parsed.origin;
}

function isKubernetesServiceHost(hostname: string): boolean {
  const labels = hostname.split(".");
  return labels.length === 5 &&
    DNS_1123_LABEL.test(labels[0] ?? "") &&
    DNS_1123_LABEL.test(labels[1] ?? "") &&
    labels[2] === "svc" &&
    labels[3] === "cluster" &&
    labels[4] === "local";
}

/** #157: parse the bulk global-wall env (a security selector — fail CLOSED at boot on malformed).
 *  Unset / empty / whitespace-only → undefined (absent operator config). Otherwise a strict decimal
 *  integer of ms in [1, ceiling] → that number; anything else throws (names the env var + range).
 *  The regex runs AFTER .trim() (so surrounding whitespace / a heredoc trailing newline on a valid
 *  value is accepted — the #1 ConfigMap contamination) and rejects non-decimal shapes an operator
 *  did not literally type (hex 0x10, scientific 1e5, floats, signs, internal whitespace, unicode
 *  digits). Leading zeros (055000) are accepted at no security cost (still decimal-only, bounded). */
