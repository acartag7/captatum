import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { JWK } from "jose";
import {
  Bridge,
  RequestAuthorizer,
  signAccessToken,
  createBridgeConfig,
  type BridgeConfig,
  type ClientStore,
  type IdentityPort,
} from "mcp-sso";
import { createMemoryStore } from "mcp-sso/store/memory";
import type { AuditLoggerPort } from "../application/ports/audit.ts";
import type { ClockPort } from "../application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../application/ports/fetcher.ts";
import type { TransformInput, TransformPort, TransformResult } from "../application/ports/transformer.ts";
import { createCaptatumUseCase } from "../application/use-cases/captatum.ts";
import { config } from "../config.ts";
import type { Result } from "../domain/result.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createHttpApp } from "../interfaces/http/app.ts";
import { InMemoryAuthRateLimit } from "../infrastructure/in-memory-auth-rate-limit.ts";
import { resultToMcpText } from "../interfaces/mcp/format.ts";

const SAFE_URL = "https://smoke.test/fixture";
const BLOCKED_URL = "http://169.254.169.254/latest/meta-data";
const SPA_URL = "https://smoke.test/spa";
const FIXTURE_TEXT = "captatum shared smoke fixture content.";
const clock: ClockPort = { nowMs: () => Date.parse("2026-06-16T12:00:00.000Z") };
const smokeClientStore: ClientStore = {
  async save(): Promise<void> {},
  async find(): Promise<null> { return null; },
};

class SmokeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    if (url.includes("169.254.169.254")) {
      return { rejected: true, code: "private_address", message: "Host resolves to a private or reserved address" };
    }
    return fetchResult(url, url.includes("/spa") ? spaHtml() : contentHtml());
  }
}

class SmokeTransformer implements TransformPort {
  readonly calls: TransformInput[] = [];

  async transform(input: TransformInput): Promise<TransformResult> {
    this.calls.push(input);
    return {
      result: `Smoke summary: ${FIXTURE_TEXT}`,
      info: { provider: "fixture", model: "local-fake", free: true, inTokens: 42, outTokens: 9, latencyMs: 0 },
    };
  }
}

class SmokeAudit implements AuditLoggerPort {
  async writeAuthEvent(): Promise<void> {}
  async writeToolEvent(): Promise<void> {}
}

// A synthetic IdentityPort for the smoke test — the hosted /oauth/authorize route is
// registered but not exercised here (the smoke mints a token directly and calls /mcp),
// so this only needs to be a valid IdentityPort.
const smokeIdentity: IdentityPort = {
  async verify() {
    return { ok: true, identity: { subject: "smoke-user" } };
  },
};

const oauth = hostedConfig();
const fetcher = new SmokeFetcher();
const transformer = new SmokeTransformer();
const captatum = createCaptatumUseCase({ fetcher, extractHtml, transformer, clock });

printResult("raw safe fetch", await captatum.execute({ url: SAFE_URL, output: "raw" }));
printResult("default summary with configured fake provider", await captatum.execute({ url: SAFE_URL }));
printResult("blocked SSRF URL", await captatum.execute({ url: BLOCKED_URL, output: "raw" }));
printResult("render-disabled default behavior", await captatum.execute({ url: SPA_URL, output: "raw" }));

const port = await freePort();
const audit = new SmokeAudit();
const authRateLimit = new InMemoryAuthRateLimit(clock); // shared: Bridge + app
const app = await createHttpApp({
  authRateLimit,
  captatum,
  flavor: "hosted",
  bridge: new Bridge({ config: oauth, store: createMemoryStore(), clock, audit, rateLimit: authRateLimit }),
  authorizer: new RequestAuthorizer({ config: oauth, clock, audit }),
  identity: smokeIdentity,
  clock,
  audit,
  allowedHosts: [`127.0.0.1:${port}`],
  allowedOrigins: ["https://client.test"],
  trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
  proxyAuthSecret: randomBytes(32).toString("base64url"),
});
const token = await signAccessToken(
  { subject: "smoke-user", clientId: "smoke-client", scopes: ["fetch:read"] },
  oauth,
  clock,
);
await app.listen({ host: "127.0.0.1", port });
const hosted = await fetch(`http://127.0.0.1:${port}${config.mcp.endpointPath}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    origin: "https://client.test",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": config.mcp.stableProtocolVersion,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "captatum", arguments: { url: SAFE_URL, output: "raw" } },
  }),
});
const hostedResponseText = await hosted.text();
await app.close();
if (hosted.status !== 200) throw new Error(`hosted MCP smoke failed: ${hosted.status} ${hostedResponseText}`);
const hostedBody = JSON.parse(hostedResponseText) as SmokeRpcResponse;
const hostedText = hostedBody.result?.content?.[0]?.text ?? "";
if (!hostedText.includes(FIXTURE_TEXT)) throw new Error(`hosted MCP smoke returned unexpected body: ${hostedResponseText}`);
console.log("--- hosted MCP authenticated call ---");
console.log(hostedText);
console.log(JSON.stringify(pick(hostedBody.result?.structuredContent), null, 2));

function printResult(label: string, result: Result): void {
  console.log(`--- ${label} ---`);
  console.log(resultToMcpText(result));
  console.log(JSON.stringify(pick(result), null, 2));
}

function pick(result: unknown): Record<string, unknown> {
  const record = result as Result | undefined;
  return {
    schemaVersion: record?.schemaVersion,
    tier: record?.tier,
    output: record?.output,
    code: record?.code,
    codeText: record?.codeText,
    finalUrl: record?.finalUrl,
    resolvedVia: record?.resolvedVia,
    jsRequired: record?.jsRequired,
    transform: record?.transform,
    errors: record?.errors,
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function fetchResult(finalUrl: string, html: string): FetcherResult {
  const bytes = new TextEncoder().encode(html);
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    contentType: "text/html; charset=utf-8",
    bytes: bytes.byteLength,
  };
}

function contentHtml(): string {
  return `<main><h1>Smoke</h1><p>${FIXTURE_TEXT}</p></main>`;
}

function spaHtml(): string {
  return "<html><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>";
}

function hostedConfig(): BridgeConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return createBridgeConfig({
    issuer: "https://captatum.test",
    resource: "https://captatum.test/mcp",
    consentSigningSecret: "smoke-consent-secret-with-enough-entropy",
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "smoke-key-1" } as JWK,
    signingKeyId: "smoke-key-1",
    redirectAllowlist: ["https://client.test/callback"],
    scopeCatalog: ["fetch:read", "fetch:transform"],
    defaultScopes: ["fetch:read"],
    allowedOrigins: ["https://client.test"],
    dcr: { mode: "stored", store: smokeClientStore },
    clientCredentials: { enabled: true },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
}

interface SmokeRpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
}
