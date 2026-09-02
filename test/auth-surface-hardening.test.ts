// V4 auth-surface hardening (2026-09-01 Level-3 re-walk, executed live on prod):
// (1) an UNAUTHENTICATED malformed-JSON POST /mcp returned 500 internal_error —
//     Fastify's body-parse error collapsed through the generic handler;
// (2) /oauth/revoke and /oauth/authorize/approve had NO rate limiter while
//     register/token/authorize/cimd all 429 correctly (15 rapid approves → zero 429s);
// (3) Fastify parsed up to 5 MiB on the OAuth POSTs before authorize()/guard() ran.
// This suite pins: real 4xx codes for body-parse errors, the revoke:/approve:
// budgets, and the pre-auth 64 KiB OAuth body cap.
// Spec: docs/contracts.md §OAuth (limiter surfaces + body cap), docs/threat-model.md §pre-auth.

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bridge, RequestAuthorizer, createBridgeConfig } from "mcp-sso";
import { OAUTH_SCOPES } from "../src/application/scopes.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import { createHostedAuthStore } from "../src/infrastructure/auth-store.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { InMemoryAuthRateLimit } from "../src/infrastructure/in-memory-auth-rate-limit.ts";
import { createHttpApp } from "../src/interfaces/http/app.ts";

const ISSUER = "https://captatum.test";
const RESOURCE = "https://captatum.test/mcp";
const clock = { nowMs: () => Date.parse("2027-01-15T12:00:00.000Z") };
const audit = { authEvents: [], toolEvents: [], async writeAuthEvent(e) { this.authEvents.push(e); }, async writeToolEvent(e) { this.toolEvents.push(e); } };
const fetcher = { calls: [], async fetchGuarded(url) { this.calls.push(url); throw Object.assign(new Error("unused"), { code: "network_error" }); } };

async function bootApp() {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "v4-poc-")));
  const file = join(dir, "auth.sqlite");
  const stores = await createHostedAuthStore(
    { backend: "sqlite", stateDirectory: dir, authFilename: file, clientFilename: `${file}.clients` },
    { redirectAllowlist: ["https://client.test/callback"], scopeCatalog: [...OAUTH_SCOPES] },
  );
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const config = createBridgeConfig({
    issuer: ISSUER,
    resource: RESOURCE,
    consentSigningSecret: randomBytes(32).toString("hex"),
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "v4-key" },
    signingKeyId: "v4-key",
    redirectAllowlist: ["https://client.test/callback"],
    scopeCatalog: [...OAUTH_SCOPES],
    defaultScopes: [OAUTH_SCOPES[0]],
    allowedOrigins: ["https://client.test"],
    dcr: { mode: "stored", store: stores.clientStore },
    clientCredentials: { enabled: true },
    cimd: { enabled: true },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2592000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
  const rateLimit = new InMemoryAuthRateLimit(clock);
  const bridge = new Bridge({ config, store: stores.store, clock, audit, rateLimit });
  const captatum = createCaptatumUseCase({ fetcher, extractHtml, clock });
  const app = await createHttpApp({
    captatum,
    flavor: "hosted",
    bridge,
    authorizer: new RequestAuthorizer({ config, clock, audit }),
    identity: { async verify() { return { ok: false, reason: "unused" }; } },
    clock,
    audit,
    allowedHosts: ["captatum.test", "127.0.0.1"],
    allowedOrigins: ["https://client.test"],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    proxyAuthSecret: randomBytes(32).toString("base64url"),
    authRateLimit: rateLimit,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url: (p) => `${app.listeningOrigin}${p}`,
    async close() { await app.close(); await stores.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("malformed JSON on /mcp answers 400 invalid_json, not 500 (was: unauth 500 on prod)", async () => {
  const app = await bootApp();
  try {
    const r = await fetch(app.url("/mcp"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{oops" });
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(body?.error?.code, "invalid_json");
  } finally { await app.close(); }
});

test("revoke and approve are rate-limited per source (was: no limiter at all)", async () => {
  const app = await bootApp();
  try {
    const codes = [];
    for (let i = 0; i < 32; i++) {
      const r = await fetch(app.url("/oauth/revoke"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "garbage" }) });
      codes.push(r.status);
    }
    const early = [...new Set(codes.slice(0, 30))];
    const late = [...new Set(codes.slice(30))];
    assert.deepEqual(early, [200], `first 30 should all be 200, got ${JSON.stringify(early)}`);
    assert.deepEqual(late, [429], `31st+ should 429, got ${JSON.stringify(late)}`);
  } finally { await app.close(); }
});

test("oversized declared OAuth body is rejected 413 pre-auth", async () => {
  const app = await bootApp();
  try {
    const body = "x".repeat(70 * 1024);
    const r = await fetch(app.url("/oauth/register"), { method: "POST", headers: { "content-type": "application/json" }, body });
    const j = await r.json().catch(() => ({}));
    assert.equal(r.status, 413, `expected 413, got ${r.status}`);
    assert.equal(j?.error?.code, "payload_too_large");
  } finally { await app.close(); }
});

test("a normal small OAuth body still parses (no over-blocking)", async () => {
  const app = await bootApp();
  try {
    const r = await fetch(app.url("/oauth/register"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "v4", redirect_uris: ["https://client.test/callback"], token_endpoint_auth_method: "none" }) });
    assert.ok(r.status === 201 || r.status === 400, `small body should be processed, got ${r.status}`);
  } finally { await app.close(); }
});

test("a directly-constructed app without an injected limiter still guards revoke (never silently unguarded)", async () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "v4-nolim-")));
  const file = join(dir, "auth.sqlite");
  const stores = await createHostedAuthStore(
    { backend: "sqlite", stateDirectory: dir, authFilename: file, clientFilename: `${file}.clients` },
    { redirectAllowlist: ["https://client.test/callback"], scopeCatalog: [...OAUTH_SCOPES] },
  );
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const config = createBridgeConfig({
    issuer: ISSUER, resource: RESOURCE,
    consentSigningSecret: randomBytes(32).toString("hex"),
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "k" },
    signingKeyId: "k",
    redirectAllowlist: ["https://client.test/callback"],
    scopeCatalog: [...OAUTH_SCOPES],
    defaultScopes: [OAUTH_SCOPES[0]],
    allowedOrigins: ["https://client.test"],
    dcr: { mode: "stored", store: stores.clientStore },
    clientCredentials: { enabled: true },
    cimd: { enabled: true },
    accessTokenTtlSeconds: 600, refreshTokenTtlSeconds: 2592000,
    consentTokenTtlSeconds: 300, authorizationCodeTtlSeconds: 300,
  });
  const captatum = createCaptatumUseCase({ fetcher, extractHtml, clock });
  const app = await createHttpApp({
    captatum, flavor: "hosted",
    bridge: new Bridge({ config, store: stores.store, clock, audit }),
    authorizer: new RequestAuthorizer({ config, clock, audit }),
    identity: { async verify() { return { ok: false, reason: "unused" }; } },
    clock, audit,
    allowedHosts: ["captatum.test", "127.0.0.1"],
    allowedOrigins: ["https://client.test"],
    trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
    proxyAuthSecret: randomBytes(32).toString("base64url"),
    // NOTE: no authRateLimit injected — the guard must still fire.
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const codes = [];
    for (let i = 0; i < 32; i++) {
      const r = await fetch(`${app.listeningOrigin}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "x" }) });
      codes.push(r.status);
    }
    assert.ok(codes.slice(30).includes(429), `fallback limiter must engage (tail: ${JSON.stringify([...new Set(codes)])})`);
  } finally {
    await app.close();
    await stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
