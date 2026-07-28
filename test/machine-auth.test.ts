import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { decodeJwt, type JWK } from "jose";
import {
  Bridge,
  RequestAuthorizer,
  createBridgeConfig,
  disableMachineClient,
  provisionMachineClient,
  rotateMachineClientSecret,
  type AuthAuditEvent,
  type IdentityPort,
} from "mcp-sso";
import type { AuditLoggerPort, ToolAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult } from "../src/application/ports/fetcher.ts";
import type { TransformPort } from "../src/application/ports/transformer.ts";
import { OAUTH_SCOPES } from "../src/application/scopes.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import { createHostedAuthStore } from "../src/infrastructure/auth-store.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { createHttpApp } from "../src/interfaces/http/app.ts";
import { startHostedServer } from "../src/server.ts";
import { runMachineClientCli } from "../src/machine-client.ts";
import {
  APPLICATION_AGENT_DOCUMENT,
  applicationAgentArguments,
} from "./support/application-agent-contract.ts";
import {
  authenticatedForwardingHeaders,
  TEST_PROXY_AUTH_SECRET,
} from "./support/proxy-auth.ts";

const SAFE_TMP = realpathSync(tmpdir());
const ISSUER = "https://captatum.test";
const RESOURCE = "https://captatum.test/mcp";
const ORIGIN = "https://client.test";

class MutableClock implements ClockPort {
  private ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
  advanceSeconds(seconds: number): void { this.ms += seconds * 1000; }
}

class MemoryAudit implements AuditLoggerPort {
  readonly authEvents: AuthAuditEvent[] = [];
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> { this.authEvents.push(event); }
  async writeToolEvent(_event: ToolAuditEvent): Promise<void> {}
}

class FakeFetcher implements FetcherPort {
  async fetchGuarded(url: string, _opts: FetcherOptions): Promise<FetcherResult> {
    const body = new TextEncoder().encode(
      `<main>${"machine-auth acceptance content ".repeat(30)}</main>`,
    );
    return {
      status: 200,
      finalUrl: url,
      redirects: [],
      bodyStream: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
      contentType: "text/html",
      bytes: body.byteLength,
    };
  }
}

const unusedIdentity: IdentityPort = {
  async verify() { return { ok: false, reason: "not_used" }; },
};

const transformer: TransformPort = {
  async transform() {
    return {
      result: JSON.stringify(APPLICATION_AGENT_DOCUMENT),
      info: { provider: "test", model: "fixed-extract" },
    };
  },
};

async function setup(existing?: {
  dir: string;
  file: string;
  clock: MutableClock;
  audit: MemoryAudit;
}) {
  const dir = existing?.dir
    ?? mkdtempSync(join(SAFE_TMP, "captatum-machine-auth-"));
  const file = existing?.file ?? join(dir, "auth.sqlite");
  const clientFile = `${file}.clients`;
  const stores = await createHostedAuthStore({
    backend: "sqlite", stateDirectory: dir,
    authFilename: file, clientFilename: clientFile,
  });
  const clock = existing?.clock
    ?? new MutableClock(Date.parse("2027-01-15T12:00:00.000Z"));
  const audit = existing?.audit ?? new MemoryAudit();
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const config = createBridgeConfig({
    issuer: ISSUER,
    resource: RESOURCE,
    consentSigningSecret: randomBytes(32).toString("hex"),
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "machine-key" } as JWK,
    signingKeyId: "machine-key",
    redirectAllowlist: ["https://client.test/callback"],
    scopeCatalog: [...OAUTH_SCOPES],
    defaultScopes: [OAUTH_SCOPES[0]],
    allowedOrigins: [ORIGIN],
    dcr: { mode: "stored", store: stores.clientStore },
    clientCredentials: { enabled: true },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
  const bridge = new Bridge({ config, store: stores.store, clock, audit });
  const authorizer = new RequestAuthorizer({ config, clock, audit });
  const captatum = createCaptatumUseCase({
    fetcher: new FakeFetcher(),
    extractHtml,
    transformer,
    clock,
  });
  const app = await createHttpApp({
    captatum,
    flavor: "hosted",
    bridge,
    authorizer,
    identity: unusedIdentity,
    clock,
    audit,
    allowedHosts: ["captatum.test"],
    allowedOrigins: [ORIGIN],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    proxyAuthSecret: TEST_PROXY_AUTH_SECRET,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    audit,
    clock,
    dir,
    file,
    clientFile,
    stores,
    async close(remove = true) {
      await app.close();
      await stores.close();
      if (remove) rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function exchange(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  clientId: string,
  clientSecret: string,
  forwardedFor?: string,
) {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "fetch:transform",
  }).toString();
  return requestHttp(app, "/oauth/token", "POST", {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(forwardedFor ? authenticatedForwardingHeaders(forwardedFor) : {}),
    }, payload);
}

async function callCaptatum(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  accessToken: string,
) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "captatum",
      arguments: applicationAgentArguments("https://example.com"),
    },
  });
  return requestHttp(app, "/mcp", "POST", {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  }, payload);
}

async function requestHttp(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  payload = "",
): Promise<{ statusCode: number; body: string }> {
  const origin = new URL(app.listeningOrigin);
  return new Promise<{ statusCode: number; body: string }>(
    (resolvePromise, rejectPromise) => {
      const request = httpRequest({
        hostname: origin.hostname,
        port: origin.port,
        path,
        method,
        headers: {
          host: "captatum.test",
          ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", rejectPromise);
        response.on("end", () => resolvePromise({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", rejectPromise);
      request.end(payload || undefined);
    },
  );
}

test("machine provision persists only a hash and exchanges for a scoped token", async () => {
  const ctx = await setup();
  try {
    const credential = await provisionMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      { name: "nightly-fetch", allowedScopes: ["fetch:transform"] },
    );
    const metadata = await ctx.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    const metadataBody = JSON.parse(metadata.body);
    assert.ok(metadataBody.grant_types_supported.includes("client_credentials"));
    assert.ok(metadataBody.token_endpoint_auth_methods_supported.includes("client_secret_basic"));

    const token = await exchange(ctx.app, credential.clientId, credential.clientSecret);
    assert.equal(token.statusCode, 200, token.body);
    const tokenBody = JSON.parse(token.body);
    assert.equal(tokenBody.refresh_token, undefined);
    assert.equal(tokenBody.expires_in, 600);
    const claims = decodeJwt(tokenBody.access_token);
    assert.equal(claims.sub, credential.clientId);
    assert.equal(claims.client_id, credential.clientId);
    assert.equal(claims.gty, "client_credentials");
    const mcp = await callCaptatum(ctx.app, tokenBody.access_token);
    assert.equal(mcp.statusCode, 200, mcp.body);
    const rpc = JSON.parse(mcp.body);
    assert.equal(rpc.id, 1);
    assert.equal(rpc.result.structuredContent.output, "extract");
    assert.equal(rpc.result.content.length, 1);
    assert.match(rpc.result.content[0].text, /^<!-- captatum /);
    assertApplicationAgentCompatibility(rpc);

    const db = new DatabaseSync(ctx.clientFile, { readOnly: true });
    const row = db.prepare("SELECT secrets_json FROM oauth_clients WHERE client_id = ?").get(credential.clientId);
    db.close();
    const stored = String(row?.secrets_json);
    assert.ok(!stored.includes(credential.clientSecret), "raw machine secret must never be persisted");
    const auditText = JSON.stringify(ctx.audit.authEvents);
    assert.ok(!auditText.includes(credential.clientSecret), "raw machine secret must never enter audits");
    const storedHash = JSON.parse(stored)[0].hash as string;
    assert.ok(!auditText.includes(storedHash), "machine secret hash must never enter audits");
  } finally {
    await ctx.close();
  }
});

function assertApplicationAgentCompatibility(rpc: Record<string, any>): void {
  assert.deepEqual(Object.keys(rpc).sort(), ["id", "jsonrpc", "result"]);
  assert.deepEqual(Object.keys(rpc.result).sort(), ["content", "structuredContent"]);
  assert.deepEqual(Object.keys(rpc.result.content[0]).sort(), ["text", "type"]);
  assert.equal(rpc.result.content[0].type, "text");
  const receipt = rpc.result.structuredContent as Record<string, any>;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "access", "bytes", "code", "codeText", "contentType", "errors", "finalUrl",
    "images", "jsRequired", "ok", "output", "outputRequested", "platform",
    "provenance", "resolvedVia", "result", "schemaVersion", "status", "tier",
    "transform", "url", "warnings",
  ]);
  assert.deepEqual(Object.keys(receipt.platform).sort(), [
    "adapterId", "detectedFrom", "label",
  ]);
  assert.deepEqual(Object.keys(receipt.access).sort(), [
    "gateReason", "gated", "mainContentAccessible",
  ]);
  assert.deepEqual(Object.keys(receipt.provenance).sort(), [
    "bytes", "code", "resolvedVia", "tier",
  ]);
  assert.deepEqual(Object.keys(receipt.transform).sort(), ["model", "provider"]);
  assert.deepEqual(receipt.warnings, []);
  assert.deepEqual(receipt.errors, []);

  const expectedProvenance = [
    "<!-- captatum",
    `tier=${receipt.tier}`,
    "output=extract",
    `status=${receipt.code}`,
    `bytes=${receipt.bytes}`,
    `finalUrl=${receipt.finalUrl}`,
    `platform=${receipt.platform.adapterId}`,
    `jsRequired=${receipt.jsRequired}`,
    `resolvedVia=${receipt.resolvedVia}`,
    "-->",
  ].join(" ");
  const text = rpc.result.content[0].text as string;
  const [provenance, header, json, ...extra] = text.split("\n\n");
  assert.equal(provenance, expectedProvenance);
  assert.deepEqual(header?.split("\n"), [
    `contentType: ${receipt.contentType}`,
    `finalUrl: ${receipt.finalUrl}`,
    "access: public",
    "images: 0",
    `transformModel: ${receipt.transform.model}`,
  ]);
  assert.equal(json, receipt.result);
  assert.deepEqual(extra, []);
  assert.deepEqual(JSON.parse(json!), APPLICATION_AGENT_DOCUMENT);
}

test("poisoned machine records fail closed as invalid_client instead of a token-endpoint 500", async () => {
  const ctx = await setup();
  try {
    const credential = await provisionMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      { allowedScopes: ["fetch:transform"] },
    );
    const db = new DatabaseSync(ctx.clientFile);
    db.prepare("UPDATE oauth_clients SET secrets_json = ? WHERE client_id = ?").run(
      JSON.stringify([{ hash: "invalid", createdAtEpoch: Math.floor(ctx.clock.nowMs() / 1000) }]),
      credential.clientId,
    );
    db.close();
    const token = await exchange(ctx.app, credential.clientId, credential.clientSecret);
    assert.equal(token.statusCode, 401, token.body);
    assert.equal(JSON.parse(token.body).error, "invalid_client");
  } finally {
    await ctx.close();
  }
});

test("machine secret rotation keeps bounded grace then rejects the old secret", async () => {
  const ctx = await setup();
  try {
    const first = await provisionMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      { allowedScopes: ["fetch:transform"] },
    );
    const next = await rotateMachineClientSecret(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      first.clientId,
      { graceSeconds: 10 },
    );
    assert.equal((await exchange(ctx.app, first.clientId, first.clientSecret)).statusCode, 200);
    assert.equal((await exchange(ctx.app, first.clientId, next.clientSecret)).statusCode, 200);
    ctx.clock.advanceSeconds(11);
    assert.equal((await exchange(ctx.app, first.clientId, first.clientSecret)).statusCode, 401);
    assert.equal((await exchange(ctx.app, first.clientId, next.clientSecret)).statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test("concurrent SQLite rotations return one valid credential and one pre-output conflict", async () => {
  const ctx = await setup();
  try {
    const first = await provisionMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      { allowedScopes: ["fetch:transform"] },
    );
    const outcomes = await Promise.allSettled([
      rotateMachineClientSecret(
        { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
        first.clientId,
        { graceSeconds: 10 },
      ),
      rotateMachineClientSecret(
        { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
        first.clientId,
        { graceSeconds: 10 },
      ),
    ]);
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ clientSecret: string; version: number }> =>
        outcome.status === "fulfilled",
    );
    const losers = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal((losers[0]!.reason as { status?: number }).status, 409);
    assert.equal(
      (await exchange(ctx.app, first.clientId, winners[0]!.value.clientSecret)).statusCode,
      200,
      "every successfully returned secret remains valid",
    );
  } finally {
    await ctx.close();
  }
});

test("failed CLI output cannot disable a newer successfully returned rotation", async () => {
  const ctx = await setup();
  try {
    const first = await provisionMachineClient(
      {
        store: ctx.stores.clientStore,
        catalog: OAUTH_SCOPES,
        clock: ctx.clock,
        audit: ctx.audit,
      },
      { allowedScopes: ["fetch:transform"] },
    );
    let concurrent: { clientSecret: string; version: number } | undefined;
    const failedOutput = new Writable({
      write(_chunk, _encoding, callback) {
        void rotateMachineClientSecret(
          {
            store: ctx.stores.clientStore,
            catalog: OAUTH_SCOPES,
            clock: ctx.clock,
            audit: ctx.audit,
          },
          first.clientId,
          { graceSeconds: 10 },
        ).then(
          (value) => {
            concurrent = value;
            callback(Object.assign(
              new Error("broken output"),
              { code: "EPIPE" },
            ));
          },
          (error) => callback(
            error instanceof Error ? error : new Error("rotation failed"),
          ),
        );
      },
    });
    const exitCode = await runMachineClientCli(
      ["rotate", first.clientId, "10"],
      {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: ctx.file },
        clock: ctx.clock,
        stdout: failedOutput as never,
        stderr: { completion: "synchronous", write() { return true; } },
      },
    );
    assert.equal(exitCode, 2, "exact-version compensation reports the CAS conflict");
    assert.equal(concurrent?.version, 3);
    assert.equal(
      (await exchange(
        ctx.app,
        first.clientId,
        concurrent!.clientSecret,
      )).statusCode,
      200,
      "the newer emitted secret remains valid",
    );
    const current = await ctx.stores.clientStore.find(first.clientId);
    assert.equal(
      current?.applicationType === "machine" ? current.status : undefined,
      "active",
    );
    assert.equal(
      current?.applicationType === "machine" ? current.version : undefined,
      3,
    );
  } finally {
    await ctx.close();
  }
});

test("disable rejects new tokens while already-issued bearer expires on schedule", async () => {
  const ctx = await setup();
  try {
    const client = await provisionMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      { allowedScopes: ["fetch:transform"] },
    );
    const tokenResponse = await exchange(ctx.app, client.clientId, client.clientSecret);
    const token = JSON.parse(tokenResponse.body).access_token as string;
    await disableMachineClient(
      { store: ctx.stores.clientStore, catalog: OAUTH_SCOPES, clock: ctx.clock, audit: ctx.audit },
      client.clientId,
    );
    assert.equal((await exchange(ctx.app, client.clientId, client.clientSecret)).statusCode, 401);
    assert.equal((await callCaptatum(ctx.app, token)).statusCode, 200);
    ctx.clock.advanceSeconds(601);
    assert.equal((await callCaptatum(ctx.app, token)).statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test("restart persistence: the same credential reaches extract after a full store/app reboot", async () => {
  const firstBoot = await setup();
  let secondBoot: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const client = await provisionMachineClient(
      {
        store: firstBoot.stores.clientStore,
        catalog: OAUTH_SCOPES,
        clock: firstBoot.clock,
        audit: firstBoot.audit,
      },
      { allowedScopes: ["fetch:transform"] },
    );
    const firstToken = JSON.parse(
      (await exchange(firstBoot.app, client.clientId, client.clientSecret)).body,
    ).access_token as string;
    assert.equal((await callCaptatum(firstBoot.app, firstToken)).statusCode, 200);
    await firstBoot.close(false);

    secondBoot = await setup({
      dir: firstBoot.dir,
      file: firstBoot.file,
      clock: firstBoot.clock,
      audit: firstBoot.audit,
    });
    const secondTokenResponse = await exchange(
      secondBoot.app,
      client.clientId,
      client.clientSecret,
    );
    assert.equal(secondTokenResponse.statusCode, 200, secondTokenResponse.body);
    const secondToken = JSON.parse(secondTokenResponse.body).access_token as string;
    const mcp = await callCaptatum(secondBoot.app, secondToken);
    assert.equal(mcp.statusCode, 200, mcp.body);
    assert.equal(JSON.parse(mcp.body).result.structuredContent.output, "extract");
  } finally {
    if (secondBoot) await secondBoot.close();
    else {
      try { await firstBoot.close(); } catch { /* already closed */ }
      rmSync(firstBoot.dir, { recursive: true, force: true });
    }
  }
});

test("shipped server boots, accepts Basic machine auth, and persists it across restart", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-shipped-server-"));
  const file = join(dir, "auth.sqlite");
  const restoreEnv = installHostedEnv(file);
  const clock = new MutableClock(Date.parse("2027-01-15T12:00:00.000Z"));
  const audit = new MemoryAudit();
  let runtime: Awaited<ReturnType<typeof startHostedServer>> | undefined;
  try {
    runtime = await startHostedServer({
      host: "127.0.0.1",
      port: 0,
      clock,
      audit,
      fetcher: new FakeFetcher(),
      transformer,
      renderer: null,
      identity: unusedIdentity,
      log: () => {},
    });
    const credential = await provisionMachineClient(
      {
        store: runtime.stores.clientStore,
        catalog: OAUTH_SCOPES,
        clock,
        audit,
      },
      { name: "application-agent", allowedScopes: ["fetch:transform"] },
    );
    await assertRegistrationFloodBounded(runtime.app, credential);
    await assertShippedMachineCall(runtime.app, credential);
    await runtime.close();
    runtime = undefined;

    runtime = await startHostedServer({
      host: "127.0.0.1",
      port: 0,
      clock,
      audit,
      fetcher: new FakeFetcher(),
      transformer,
      renderer: null,
      identity: unusedIdentity,
      log: () => {},
    });
    await assertShippedMachineCall(runtime.app, credential);
  } finally {
    await runtime?.close();
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function assertRegistrationFloodBounded(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  credential: { clientId: string; clientSecret: string },
): Promise<void> {
  const payload = JSON.stringify({
    redirect_uris: ["https://client.test/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
  });
  const register = (forwardedFor: string) => requestHttp(
    app,
    "/oauth/register",
    "POST",
    {
      "content-type": "application/json",
      ...authenticatedForwardingHeaders(forwardedFor),
    },
    payload,
  );
  const directRegister = () => requestHttp(
    app,
    "/oauth/register",
    "POST",
    { "content-type": "application/json" },
    payload,
  );
  for (const [header, value] of [
    ["forwarded", "for=203.0.113.1"],
    ["x-forwarded-for", "203.0.113.1"],
    ["x-forwarded-host", "attacker.example"],
    ["x-forwarded-proto", "javascript"],
    ["x-forwarded-port", "31337"],
    ["x-real-ip", "203.0.113.1"],
    ["cf-connecting-ip", "203.0.113.1"],
  ]) {
    assert.equal(
      (await requestHttp(
        app,
        "/oauth/register",
        "POST",
        {
          "content-type": "application/json",
          [header]: value,
        },
        payload,
      )).statusCode,
      400,
      `the same-peer browser cannot assert ${header} without edge authentication`,
    );
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await directRegister()).statusCode, 201);
  }
  assert.equal(
    (await directRegister()).statusCode,
    429,
    "the same-peer browser stays in one bounded direct-source bucket",
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const accepted = await register("198.51.100.10");
    assert.equal(accepted.statusCode, 201, accepted.body);
  }
  const rejected = await register("198.51.100.10");
  assert.equal(rejected.statusCode, 429, rejected.body);
  assert.equal(JSON.parse(rejected.body).error, "temporarily_unavailable");
  assert.equal(
    (await register("198.51.100.11")).statusCode,
    201,
    "the trusted tunnel attributes a second public source independently",
  );

  for (let attempt = 0; attempt < 10; attempt++) {
    const direct = await app.inject({
      method: "POST",
      url: "/oauth/register",
      remoteAddress: "192.0.2.20",
      headers: {
        host: "captatum.test",
        "content-type": "application/json",
        ...authenticatedForwardingHeaders(`203.0.113.${attempt + 1}`),
      },
      payload,
    });
    assert.equal(direct.statusCode, 201, direct.body);
  }
  const spoofRejected = await app.inject({
    method: "POST",
    url: "/oauth/register",
    remoteAddress: "192.0.2.20",
    headers: {
      host: "captatum.test",
      "content-type": "application/json",
      ...authenticatedForwardingHeaders("203.0.113.200"),
    },
    payload,
  });
  assert.equal(
    spoofRejected.statusCode,
    429,
    "an untrusted direct peer cannot select buckets with forwarding headers",
  );

  assert.equal(
    (await requestHttp(
      app,
      "/oauth/token",
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.2",
      },
      new URLSearchParams({
        grant_type: "client_credentials",
        scope: "fetch:transform",
      }).toString(),
    )).statusCode,
    400,
    "the same-peer browser cannot assert a token-limit identity without edge authentication",
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    const invalid = await exchange(app, "mcc_missing", "mcs_missing");
    assert.equal(invalid.statusCode, 401, invalid.body);
  }
  assert.equal(
    (await exchange(app, "mcc_missing", "mcs_missing")).statusCode,
    429,
    "the same-peer browser stays in one bounded direct token bucket",
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    const invalid = await exchange(
      app,
      "mcc_missing",
      "mcs_missing",
      "198.51.100.30",
    );
    assert.equal(invalid.statusCode, 401, invalid.body);
  }
  assert.equal(
    (await exchange(
      app,
      "mcc_missing",
      "mcs_missing",
      "198.51.100.30",
    )).statusCode,
    429,
  );
  assert.equal(
    (await exchange(
      app,
      credential.clientId,
      credential.clientSecret,
      "198.51.100.31",
    )).statusCode,
    200,
    "a second public source can still renew a machine token",
  );
}

async function assertShippedMachineCall(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  credential: { clientId: string; clientSecret: string },
): Promise<void> {
  const metadata = await requestHttp(
    app,
    "/.well-known/oauth-authorization-server",
    "GET",
  );
  assert.equal(metadata.statusCode, 200, metadata.body);
  const metadataBody = JSON.parse(metadata.body);
  assert.ok(metadataBody.grant_types_supported.includes("client_credentials"));
  assert.ok(
    metadataBody.token_endpoint_auth_methods_supported.includes(
      "client_secret_basic",
    ),
  );
  const tokenResponse = await exchange(
    app,
    credential.clientId,
    credential.clientSecret,
    "198.51.100.50",
  );
  assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
  const token = JSON.parse(tokenResponse.body);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.expires_in, 600);
  assert.equal(token.scope, "fetch:transform");
  assert.equal(token.refresh_token, undefined);
  const mcp = await callCaptatum(app, token.access_token);
  assert.equal(mcp.statusCode, 200, mcp.body);
  assertApplicationAgentCompatibility(JSON.parse(mcp.body));
}

function installHostedEnv(file: string): () => void {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const values: Record<string, string> = {
    CAPTATUM_FLAVOR: "hosted",
    CAPTATUM_SQLITE_PATH: file,
    CAPTATUM_BULK_ENABLED: "false",
    OAUTH_ISSUER: ISSUER,
    OAUTH_RESOURCE: RESOURCE,
    OAUTH_CONSENT_SIGNING_SECRET: randomBytes(32).toString("hex"),
    OAUTH_SIGNING_PRIVATE_JWK: JSON.stringify({
      ...privateKey.export({ format: "jwk" }),
      alg: "ES256",
      kid: "shipped-server-key",
    }),
    OAUTH_SIGNING_KEY_ID: "shipped-server-key",
    OAUTH_REDIRECT_ALLOWLIST: "https://client.test/callback",
    MCP_ALLOWED_HOSTS: "captatum.test",
    MCP_ALLOWED_ORIGINS: ORIGIN,
    CAPTATUM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    CAPTATUM_PROXY_AUTH_SECRET: TEST_PROXY_AUTH_SECRET,
    CF_ACCESS_ENABLED: "true",
    CF_ACCESS_AUDIENCE: "test-audience",
    CF_ACCESS_CERTS_URL:
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    CF_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
  };
  const tidbNames = [
    "TIDB_HOST",
    "TIDB_PORT",
    "TIDB_DATABASE",
    "TIDB_USER",
    "TIDB_PASSWORD",
    "TIDB_SSL_CA",
  ];
  const names = [...Object.keys(values), ...tidbNames];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of tidbNames) delete process.env[name];
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
