import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
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
import type { AuthAuditEvent, AuditLoggerPort, ToolAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult } from "../src/application/ports/fetcher.ts";
import type { TransformInput, TransformPort, TransformResult } from "../src/application/ports/transformer.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import { config } from "../src/config.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { assertHostedFlavor, createHttpApp, HostedFlavorError } from "../src/interfaces/http/app.ts";
import { CAPTATUM_SERVER_INSTRUCTIONS } from "../src/interfaces/mcp/schema.ts";

const NOW_MS = Date.parse("2026-06-16T12:00:00.000Z");
const HOST = "captatum.test";
const ORIGIN = "https://client.test";
const testClientStore: ClientStore = {
  async save(): Promise<void> {},
  async find(): Promise<null> { return null; },
};

// Synthetic CF-Access identity for the hosted app (the /oauth/authorize route is
// registered but not driven by these tests — they mint tokens directly — so a
// permissive stub suffices; mcp-sso-wiring.test.ts exercises the full identity flow).
const stubIdentity: IdentityPort = {
  async verify() { return { ok: true, identity: { subject: "user-1" } }; },
};

test("HTTP MCP listener refuses local-binary instead of exposing an unauthenticated /mcp", async () => {
  assert.throws(
    () => assertHostedFlavor("local-binary"),
    (error: unknown) => error instanceof HostedFlavorError && error.code === "hosted_flavor_required",
  );
  await assert.rejects(
    createHttpApp({
      captatum: createCaptatumUseCase({
        fetcher: new FakeFetcher("<main>Body</main>"),
        extractHtml,
        clock: new FakeClock(NOW_MS),
      }),
      flavor: "local-binary",
      bridge: null as unknown as Bridge,
      authorizer: null as unknown as RequestAuthorizer,
      identity: stubIdentity,
      clock: new FakeClock(NOW_MS),
      audit: new MemoryAudit(),
      allowedHosts: [HOST],
      allowedOrigins: [ORIGIN],
      trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    }),
    (error: unknown) => error instanceof HostedFlavorError,
  );
});

test("POST /mcp rejects unauthenticated hosted calls before captatum runs", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "raw" } }, undefined);

  assert.equal(response.statusCode, 401);
  // mcp-sso buildUnauthorizedChallenge: RFC 9728 resource_metadata + scope + error. The
  // prior captatum realm="captatum" form was retired with the in-house OAuth stack; the
  // human remedy rides the JSON-RPC message + the PRM doc the client can now discover.
  const wwwAuth = String(response.headers["www-authenticate"]);
  assert.match(wwwAuth, /^Bearer resource_metadata="/);
  assert.match(wwwAuth, /error="invalid_token"/);
  const body = response.json();
  assert.equal(body.id, null);
  assert.equal(body.error.code, -32003);
  assert.match(body.error.message, /^invalid_token:/);
  assert.equal(ctx.fetcher.calls.length, 0);
  await ctx.app.close();
});

test("POST /mcp with a malformed Bearer token returns 401 invalid_token (#104 evolved)", async () => {
  const ctx = await setup();
  const response = await ctx.rpc(
    { arguments: { url: "https://fixture.test/", output: "raw" } },
    undefined,
    { authorization: "Bearer not-a-real-jwt" },
  );
  assert.equal(response.statusCode, 401);
  const wwwAuth = String(response.headers["www-authenticate"]);
  assert.match(wwwAuth, /error="invalid_token"/);
  assert.match(wwwAuth, /resource_metadata="/);
  const body = response.json();
  assert.equal(body.error.code, -32003);
  assert.match(body.error.message, /invalid_token/);
  assert.equal(ctx.fetcher.calls.length, 0);
  await ctx.app.close();
});

test("authenticated fetch:read call can perform output raw", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/path?x=1", output: "raw" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["mcp-session-id"], undefined);
  const body = response.json() as RpcSuccess;
  assert.equal(body.result.structuredContent.output, "raw");
  assert.equal(body.result.structuredContent.result, "Fixture raw body");
  assert.match(body.result.content[0]?.text ?? "", /^<!-- captatum /);
  assert.equal(ctx.fetcher.calls.length, 1);
  assert.equal(ctx.audit.toolEvents.at(-1)?.url_host, "https://fixture.test");
  await ctx.app.close();
});

test("authenticated call without fetch:transform cannot perform summary output", async () => {
  const transformer = new FakeTransformer();
  const ctx = await setup({ transformer });
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "summary" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcError;
  assert.equal(body.error.code, -32003);
  assert.match(body.error.message, /insufficient_scope/);
  assert.equal(ctx.fetcher.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
  assert.equal(ctx.audit.toolEvents.at(-1)?.status, 403);
  await ctx.app.close();
});

test("raw output with an unused transform override permits fetch:read", async () => {
  const transformer = new FakeTransformer();
  const ctx = await setup({ transformer });
  const response = await ctx.rpc({
    arguments: { url: "https://fixture.test/", output: "raw", transform: { provider: "ollama" } },
  }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcSuccess;
  assert.equal(body.result.structuredContent.output, "raw");
  assert.equal(ctx.fetcher.calls.length, 1);
  assert.equal(transformer.calls.length, 0, "raw skips the transform stage");
  await ctx.app.close();
});

test("provider-backed default summary requires fetch:transform when output is omitted", async () => {
  const transformer = new FakeTransformer();
  const ctx = await setup({ transformer });
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcError;
  assert.equal(body.error.code, -32003);
  assert.match(body.error.message, /insufficient_scope/);
  assert.equal(ctx.fetcher.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
  await ctx.app.close();
});

test("provider-backed default summary runs with fetch:transform when output is omitted", async () => {
  const transformer = new FakeTransformer();
  const ctx = await setup({ transformer });
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/" } }, ["fetch:transform"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcSuccess;
  assert.equal(body.result.structuredContent.output, "summary");
  assert.equal(body.result.structuredContent.result, "summary");
  assert.equal(ctx.fetcher.calls.length, 1);
  assert.equal(transformer.calls.length, 1);
  await ctx.app.close();
});

test("providerless default remains raw and permits fetch:read when output is omitted", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcSuccess;
  assert.equal(body.result.structuredContent.output, "raw");
  assert.equal(body.result.structuredContent.result, "Fixture raw body");
  assert.equal(ctx.fetcher.calls.length, 1);
  await ctx.app.close();
});

test("invalid tool input returns validation error before outbound fetch", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "raw", extra: true } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcError;
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /invalid_input/);
  assert.equal(ctx.fetcher.calls.length, 0);
  assert.equal(ctx.audit.toolEvents.at(-1)?.status, 0);
  await ctx.app.close();
});

test("tools/list advertises a strict captatum input schema", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ method: "tools/list", params: {} }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as ToolsListSuccess;
  const tool = body.result.tools.find((item) => item.name === "captatum");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const phrase of ["summary", "'raw'", "'extract'", "allowRender: false", "provenance"]) {
    assert.ok(tool.description.includes(phrase), `tool description missing "${phrase}"`);
  }
  await ctx.app.close();
});

test("server advertises capability instructions for discoverability", () => {
  assert.ok(CAPTATUM_SERVER_INSTRUCTIONS.length > 200, "instructions are substantive");
  for (const phrase of ["summary", "raw", "extract", "allowRender", "Provenance", "rule of thumb"]) {
    assert.ok(CAPTATUM_SERVER_INSTRUCTIONS.includes(phrase), `instructions missing "${phrase}"`);
  }
});


test("GET and DELETE /mcp are method-not-allowed", async () => {
  const ctx = await setup();
  for (const method of ["GET", "DELETE"] as const) {
    const response = await ctx.app.inject({ method, url: config.mcp.endpointPath, headers: { host: HOST } });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "POST");
  }
  await ctx.app.close();
});

test("MCP transport rejects authenticated requests with a disallowed origin", async () => {
  const ctx = await setup();
  const response = await ctx.rpc(
    { arguments: { url: "https://fixture.test/", output: "raw" } },
    ["fetch:read"],
    { origin: "https://evil.test" },
  );

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /Invalid Origin header/);
  assert.equal(ctx.fetcher.calls.length, 0);
  await ctx.app.close();
});

async function setup(options: { transformer?: TransformPort } = {}) {
  const clock = new FakeClock(NOW_MS);
  const oauthConfig = hostedConfig();
  const fetcher = new FakeFetcher("<main>Fixture raw body</main>");
  const audit = new MemoryAudit();
  const bridge = new Bridge({ config: oauthConfig, store: createMemoryStore(), clock, audit });
  const authorizer = new RequestAuthorizer({ config: oauthConfig, clock, audit });
  const captatum = createCaptatumUseCase({ fetcher, extractHtml, transformer: options.transformer, clock });
  const app = await createHttpApp({
    captatum,
    flavor: "hosted",
    bridge,
    authorizer,
    identity: stubIdentity,
    clock,
    audit,
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
  });
  return {
    app,
    fetcher,
    audit,
    rpc: async (input: RpcInput, scopes?: string[], headers: Record<string, string> = {}) => {
      const token = scopes ? await signAccessToken({ subject: "user-1", clientId: "client-1", scopes }, oauthConfig, clock) : undefined;
      return await app.inject({
        method: "POST",
        url: config.mcp.endpointPath,
        headers: {
          host: HOST,
          origin: ORIGIN,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": config.mcp.stableProtocolVersion,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        payload: rpcPayload(input),
      });
    },
  };
}

function rpcPayload(input: RpcInput): Record<string, unknown> {
  if (input.method === "tools/list") return { jsonrpc: "2.0", id: 1, method: "tools/list", params: input.params };
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "captatum", arguments: input.arguments },
  };
}

class FakeClock implements ClockPort {
  private readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly html: string;
  constructor(html: string) { this.html = html; }
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
    this.calls.push({ url, opts });
    const bytes = new TextEncoder().encode(this.html);
    return {
      status: 200,
      finalUrl: url,
      redirects: [],
      bodyStream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      contentType: "text/html; charset=utf-8",
      bytes: bytes.byteLength,
    };
  }
}

class FakeTransformer implements TransformPort {
  readonly calls: TransformInput[] = [];
  async transform(input: TransformInput): Promise<TransformResult> {
    this.calls.push(input);
    return { result: "summary", info: { provider: "openrouter", model: "model" } };
  }
}

class MemoryAudit implements AuditLoggerPort {
  readonly authEvents: AuthAuditEvent[] = [];
  readonly toolEvents: ToolAuditEvent[] = [];
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> { this.authEvents.push(event); }
  async writeToolEvent(event: ToolAuditEvent): Promise<void> { this.toolEvents.push(event); }
}

function hostedConfig(): BridgeConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return createBridgeConfig({
    issuer: "https://captatum.test",
    resource: "https://captatum.test/mcp",
    consentSigningSecret: "test-consent-secret-with-enough-entropy",
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "test-key-1" } as JWK,
    signingKeyId: "test-key-1",
    redirectAllowlist: ["https://client.test/callback"],
    scopeCatalog: ["fetch:read", "fetch:transform"],
    defaultScopes: ["fetch:read"],
    allowedOrigins: [ORIGIN],
    dcr: { mode: "stored", store: testClientStore },
    clientCredentials: { enabled: true },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
}

type RpcInput = { method?: "tools/call"; arguments: unknown } | { method: "tools/list"; params: Record<string, unknown> };
interface RpcSuccess { result: { content: Array<{ text?: string }>; structuredContent: { output: string; result: string } } }
interface RpcError { error: { code: number; message: string } }
interface ToolsListSuccess { result: { tools: Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean } }> } }
