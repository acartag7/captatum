// mcp-sso wiring — the S0b dogfood test. Boots captatum's hosted `createHttpApp` backed
// by the mcp-sso Bridge (memory store) + a synthetic Cloudflare-Access IdentityPort and
// drives the FULL OAuth 2.1 flow a real client uses: metadata → register → authorize
// (consent) → approve → token → protected `/mcp` 200 — then the 401 + RFC 9728 challenge
// when the token is absent. This is the proof the swapped-in library produces a token
// captatum's `/mcp` actually accepts (not a directly-minted one). Mirrors mcp-sso's
// `test/lib/adapter-flow.ts` (the canonical register→authorize→approve→token sequence).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { JWK } from "jose";
import {
  Bridge,
  RequestAuthorizer,
  createBridgeConfig,
  pkceChallenge,
  type BridgeConfig,
  type ClientRegistration,
  type ClientStore,
  type IdentityPort,
} from "mcp-sso";
import { createMemoryStore } from "mcp-sso/store/memory";
import type { AuthAuditEvent, AuditLoggerPort, ToolAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult } from "../src/application/ports/fetcher.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import { config } from "../src/config.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { InMemoryAuthRateLimit } from "../src/infrastructure/in-memory-auth-rate-limit.ts";
import { createHttpApp } from "../src/interfaces/http/app.ts";
import { TEST_PROXY_AUTH_SECRET } from "./support/proxy-auth.ts";

const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");
const ISSUER = "https://captatum.test";
const RESOURCE = "https://captatum.test/mcp";
const REDIRECT = "https://client.test/callback";
const ORIGIN = "https://client.test";
const HOST = "captatum.test";
const IDENTITY_HEADER = "cf-access-jwt-assertion";
const STUB_TOKEN = "stub-good";
const SUBJECT = "agent@test";
const FIXTURE = "wiring fixture body";
const CIMD_CLIENT_ID = "https://metadata.client.test/client";
const CIMD_CLIENT_NAME = "Hosted Connector";

class FakeClock implements ClockPort {
  private readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
    this.calls.push({ url, opts });
    const bytes = new TextEncoder().encode(`<main>${FIXTURE}</main>`);
    return {
      status: 200, finalUrl: url, redirects: [],
      bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
      contentType: "text/html; charset=utf-8", bytes: bytes.byteLength,
    };
  }
}

class MemoryAudit implements AuditLoggerPort {
  readonly authEvents: AuthAuditEvent[] = [];
  readonly toolEvents: ToolAuditEvent[] = [];
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> { this.authEvents.push(event); }
  async writeToolEvent(event: ToolAuditEvent): Promise<void> { this.toolEvents.push(event); }
}

// A synthetic CF-Access IdentityPort: accepts exactly STUB_TOKEN (so the test can also
// assert the rejected-identity path), resolves to SUBJECT. Real production wires mcp-sso's
// createCloudflareAccessIdentity here; the boot gate + verify contract are identical.
const stubIdentity: IdentityPort = {
  async verify(input: unknown) {
    return input === STUB_TOKEN
      ? { ok: true, identity: { subject: SUBJECT } }
      : { ok: false, reason: "bad_identity_token" };
  },
};

function makeConfig(clientStore: ClientStore): BridgeConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return createBridgeConfig({
    issuer: ISSUER,
    resource: RESOURCE,
    consentSigningSecret: "wiring-consent-secret-with-enough-entropy",
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "wiring-key-1" } as JWK,
    signingKeyId: "wiring-key-1",
    redirectAllowlist: [REDIRECT],
    scopeCatalog: ["fetch:read", "fetch:transform"],
    defaultScopes: ["fetch:read"],
    allowedOrigins: [ORIGIN],
    dcr: { mode: "stored", store: clientStore },
    clientCredentials: { enabled: true },
    cimd: { enabled: true },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
}

async function setup() {
  const clock = new FakeClock(NOW_MS);
  const clients = new Map<string, ClientRegistration>();
  const clientStore: ClientStore = {
    async save(client): Promise<void> { clients.set(client.clientId, structuredClone(client)); },
    async find(clientId): Promise<ClientRegistration | null> {
      const client = clients.get(clientId);
      return client ? structuredClone(client) : null;
    },
  };
  const oauthConfig = makeConfig(clientStore);
  const audit = new MemoryAudit();
  const store = createMemoryStore();
  let cimdFetches = 0;
  const cimdBody = new TextEncoder().encode(JSON.stringify({
    client_id: CIMD_CLIENT_ID,
    client_name: CIMD_CLIENT_NAME,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
  }));
  const bridge = new Bridge({
    config: oauthConfig,
    store,
    clock,
    audit,
    rateLimit: new InMemoryAuthRateLimit(clock),
    cimdResolver: {
      async resolve(hostname) {
        assert.equal(hostname, "metadata.client.test");
        return [{ address: "93.184.216.34", family: 4 }];
      },
    },
    cimdTransport: {
      async connectAndGet(request) {
        cimdFetches += 1;
        assert.equal(request.connectIp, "93.184.216.34");
        assert.equal(request.redirect, "manual");
        return {
          status: 200,
          redirected: false,
          finalUrl: CIMD_CLIENT_ID,
          headersDistinct: {
            "content-type": ["application/json"],
            "cache-control": ["max-age=3600"],
          },
          encodedBody: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(cimdBody); controller.close(); },
          }),
        };
      },
    },
  });
  const authorizer = new RequestAuthorizer({ config: oauthConfig, clock, audit });
  const captatum = createCaptatumUseCase({ fetcher: new FakeFetcher(), extractHtml, clock });
  const app = await createHttpApp({
    captatum, flavor: "hosted", bridge, authorizer, identity: stubIdentity, clock, audit,
    allowedHosts: [HOST], allowedOrigins: [ORIGIN],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    proxyAuthSecret: TEST_PROXY_AUTH_SECRET,
  });
  return { app, oauthConfig, audit, cimdFetches: () => cimdFetches };
}

test("mcp-sso flow: register → authorize → approve → token → protected /mcp 200", async () => {
  const ctx = await setup();
  try {
    const verifier = "correct-horse-battery-staple-0123456789abcdef0123";
    // 1. metadata
    const meta = await ctx.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    assert.equal(meta.statusCode, 200);
    const metadata = JSON.parse(meta.body);
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.registration_endpoint, `${ISSUER}/oauth/register`);

    // 2. register through the retained DCR fallback
    const reg = await ctx.app.inject({
      method: "POST", url: "/oauth/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    assert.equal(reg.statusCode, 201);
    const clientId = JSON.parse(reg.body).client_id;

    // 3. authorize (synthetic CF identity via the assertion header) → consent page
    const authPage = await ctx.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
        scope: "fetch:read", state: "s1",
      })}`,
      headers: { [IDENTITY_HEADER]: STUB_TOKEN },
    });
    assert.equal(authPage.statusCode, 200);
    const consentToken = /name="consent_token" value="([^"]+)"/.exec(authPage.body)?.[1];
    assert.ok(consentToken, "consent token rendered in the page");

    // 4. approve → 302 with ?code=
    const approve = await ctx.app.inject({
      method: "POST", url: "/oauth/authorize/approve",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER },
      payload: new URLSearchParams({ consent_token: consentToken as string, approved: "true" }).toString(),
    });
    assert.equal(approve.statusCode, 302);
    const code = new URL(approve.headers.location as string).searchParams.get("code");
    assert.ok(code, "authorization code issued");

    // 5. token → access_token
    const token = await ctx.app.inject({
      method: "POST", url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: code as string, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: verifier,
      }).toString(),
    });
    assert.equal(token.statusCode, 200);
    const accessToken = JSON.parse(token.body).access_token as string;
    assert.match(accessToken, /^[^.]+\.[^.]+\.[^.]+$/, "JWT access token");

    // 6. protected /mcp with the flow-obtained token → 200 (captatum accepts the mcp-sso token)
    const mcpOk = await ctx.app.inject({
      method: "POST", url: config.mcp.endpointPath,
      headers: {
        host: HOST, origin: ORIGIN, authorization: `Bearer ${accessToken}`,
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": config.mcp.stableProtocolVersion,
      },
      payload: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "captatum", arguments: { url: "https://fixture.test/", output: "raw" } },
      }),
    });
    assert.equal(mcpOk.statusCode, 200, mcpOk.body);
    const okBody = JSON.parse(mcpOk.body) as { result?: { content?: Array<{ text?: string }> } };
    assert.ok((okBody.result?.content?.[0]?.text ?? "").includes(FIXTURE), "captatum ran with the mcp-sso token");
    // Audit-seam invariant: the unified audit object received the RequestAuthorizer's
    // auth.request SUCCESS event for the verified /mcp call — guards against a regression
    // that silently drops every hosted auth event (audit is evidence, not a gate, so a
    // dropped event would otherwise leave the suite green). The Bridge also emitted
    // identity.verify + oauth.* events during the flow, all into the same sink.
    assert.ok(
      ctx.audit.authEvents.some((e) => e.event === "auth.request" && e.status === "success"),
      "the hosted /mcp success wrote an auth.request success event into the unified audit sink",
    );
  } finally {
    await ctx.app.close();
  }
});

test("/mcp without a token → 401 with an RFC 9728 WWW-Authenticate challenge", async () => {
  const ctx = await setup();
  try {
    const res = await ctx.app.inject({
      method: "POST", url: config.mcp.endpointPath,
      headers: {
        host: HOST, origin: ORIGIN, "content-type": "application/json",
        accept: "application/json, text/event-stream", "mcp-protocol-version": config.mcp.stableProtocolVersion,
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "captatum", arguments: { url: "https://fixture.test/", output: "raw" } } }),
    });
    assert.equal(res.statusCode, 401);
    const wwwAuth = String(res.headers["www-authenticate"]);
    // mcp-sso buildUnauthorizedChallenge: RFC 9728 resource_metadata + scope + error.
    assert.match(wwwAuth, /^Bearer resource_metadata="/);
    assert.match(wwwAuth, /scope="fetch:read fetch:transform"/);
    assert.match(wwwAuth, /error="invalid_token"/);
    const body = JSON.parse(res.body) as { error: { code: number; message: string }; id: unknown };
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32003);
    // Audit-seam invariant (failure path): a rejected /mcp token still emits the
    // auth.request FAILURE event — the evidence trail records the denial, not just successes.
    assert.ok(
      ctx.audit.authEvents.some((e) => e.event === "auth.request" && e.status === "failure"),
      "the 401 wrote an auth.request failure event into the unified audit sink",
    );
  } finally {
    await ctx.app.close();
  }
});

test("CIMD authorize reaches the guarded resolver under Captatum's auth limiter", async () => {
  const ctx = await setup();
  try {
    const verifier = "v".repeat(43);
    const authPage = await ctx.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CIMD_CLIENT_ID,
        redirect_uri: REDIRECT,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        scope: "fetch:read",
        state: "cimd-state",
      })}`,
      headers: { [IDENTITY_HEADER]: STUB_TOKEN },
    });
    assert.equal(authPage.statusCode, 200, authPage.body);
    assert.equal(ctx.cimdFetches(), 1);
    assert.match(authPage.body, new RegExp(CIMD_CLIENT_NAME));
    assert.ok(
      ctx.audit.authEvents.some((event) =>
        event.event === "oauth.cimd.fetch" && event.status === "success"
      ),
      "successful CIMD resolution is recorded without document contents",
    );
  } finally {
    await ctx.app.close();
  }
});

test("rejected CF identity at /oauth/authorize → direct 401 access_denied (AUTH-1 fail-closed)", async () => {
  const ctx = await setup();
  try {
    const verifier = "correct-horse-battery-staple-0123";
    const auth = await ctx.app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: "anything", redirect_uri: REDIRECT,
        code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", scope: "fetch:read",
      })}`,
      headers: { [IDENTITY_HEADER]: "not-the-stub-token" },
    });
    assert.equal(auth.statusCode, 401);
    assert.equal(auth.headers.location, undefined, "identity rejection is direct, never a redirect");
    const body = JSON.parse(auth.body) as { error: string; error_description: string };
    assert.equal(body.error, "access_denied");
  } finally {
    await ctx.app.close();
  }
});
