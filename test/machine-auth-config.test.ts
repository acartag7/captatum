import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JWK } from "jose";
import {
  OAuthAuthorizationUseCase,
  createBridgeConfig,
  pkceChallenge,
  type ClientStore,
} from "mcp-sso";
import { createMemoryStore } from "mcp-sso/store/memory";
import {
  createMcpSsoConfig,
  loadCaptatumAuth,
} from "../src/application/mcp-sso-config.ts";

function validHostedEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "config-key" } as JWK;
  return {
    CAPTATUM_FLAVOR: "hosted",
    OAUTH_ISSUER: "https://captatum.test",
    OAUTH_RESOURCE: "https://captatum.test/mcp",
    OAUTH_CONSENT_SIGNING_SECRET: randomBytes(32).toString("hex"),
    OAUTH_SIGNING_PRIVATE_JWK: JSON.stringify(jwk),
    OAUTH_SIGNING_KEY_ID: "config-key",
    OAUTH_REDIRECT_ALLOWLIST: "https://client.test/callback",
    MCP_ALLOWED_ORIGINS: "https://client.test",
    CF_ACCESS_ENABLED: "true",
    CF_ACCESS_AUDIENCE: "captatum-audience",
    CF_ACCESS_CERTS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    CF_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
  };
}

const clientStore: ClientStore = {
  async save(): Promise<void> {},
  async find(): Promise<null> { return null; },
};

test("hosted OAuth material fails before any configured SQLite path is created", () => {
  const parent = join(tmpdir(), `captatum-auth-gate-${randomUUID()}`);
  const env = validHostedEnv();
  env.CAPTATUM_SQLITE_PATH = join(parent, "nested", "auth.sqlite");
  env.OAUTH_SIGNING_PRIVATE_JWK = "not-json";
  assert.throws(() => loadCaptatumAuth(env), /OAUTH_SIGNING_PRIVATE_JWK/);
  assert.equal(existsSync(parent), false, "pure auth validation must not create the state directory");
});

test("hosted security selectors reject missing, empty, and comma-only values", () => {
  for (const name of [
    "OAUTH_SIGNING_KEY_ID",
    "OAUTH_REDIRECT_ALLOWLIST",
    "MCP_ALLOWED_ORIGINS",
  ]) {
    for (const value of [undefined, "", "   ", ...(name === "OAUTH_SIGNING_KEY_ID" ? [] : [", ,"])]) {
      const env = validHostedEnv();
      if (value === undefined) delete env[name];
      else env[name] = value;
      assert.throws(
        () => loadCaptatumAuth(env),
        new RegExp(`Hosted requires ${name}`),
      );
    }
  }
});

test("final hosted config enables client credentials only with the stored ClientStore", () => {
  const runtime = loadCaptatumAuth(validHostedEnv());
  assert.equal(runtime.flavor, "hosted");
  assert.ok(runtime.material);
  const config = createMcpSsoConfig(runtime.material, clientStore);
  assert.equal(config.dcr.mode, "stored");
  if (config.dcr.mode === "stored") assert.equal(config.dcr.store, clientStore);
  assert.deepEqual(config.clientCredentials, { enabled: true });
  assert.equal(Object.isFrozen(config), true);
});

test("stored-DCR cutover rejects a browser-held stateless consent token", async () => {
  const runtime = loadCaptatumAuth(validHostedEnv());
  assert.ok(runtime.material);
  const material = runtime.material;
  const legacy = createBridgeConfig({
    ...material,
    dcr: { mode: "stateless" },
  });
  const stored = createMcpSsoConfig(material, clientStore);
  assert.notEqual(stored.consentSigningSecret, legacy.consentSigningSecret);
  assert.equal(
    stored.consentSigningSecret,
    createMcpSsoConfig(material, clientStore).consentSigningSecret,
    "the versioned derivation is stable across restart",
  );
  const clock = { nowMs: () => Date.parse("2027-01-15T12:00:00.000Z") };
  const audit = { async writeAuthEvent(): Promise<void> {} };
  const store = createMemoryStore();
  const oldAuthorization = new OAuthAuthorizationUseCase({
    config: legacy,
    store,
    clock,
    audit,
  });
  const verifier = "correct-horse-battery-staple-0123456789abcdef0123";
  const prepared = await oldAuthorization.prepare({
    clientId: "mcpdc_pre_upgrade_client",
    redirectUri: "https://client.test/callback",
    responseType: "code",
    codeChallenge: pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    resource: "https://captatum.test/mcp",
    scope: "fetch:read",
    subject: "pre-upgrade-user",
  });
  const newAuthorization = new OAuthAuthorizationUseCase({
    config: stored,
    store,
    clock,
    audit,
  });
  await assert.rejects(
    newAuthorization.approve({
      consentToken: prepared.consentToken,
      approved: true,
      origin: "https://captatum.test",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "invalid_consent");
      return true;
    },
  );
});
