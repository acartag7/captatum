import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { JWK } from "jose";
import {
  OAuthError,
  OAuthTokenUseCase,
  createBridgeConfig,
  generateRefreshToken,
  parseRefreshFamilyId,
  pkceChallenge,
  sha256Hex,
  type AuditPort,
} from "mcp-sso";
import {
  createMcpSsoConfig,
  type ValidatedAuthMaterial,
} from "../src/application/mcp-sso-config.ts";
import {
  createHostedAuthStore,
  type HostedStoreConfig,
} from "../src/infrastructure/auth-store.ts";

const NOW_MS = Date.parse("2026-07-28T12:00:00.000Z");
const FUTURE = "2027-01-01T00:00:00.000Z";
const ISSUER = "https://captatum.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://client.test/callback";
const EXISTING_CLIENT = "mcpdc_existing_generation_client";
const UNKNOWN_CLIENT = "mcpdc_unknown_generation_client";
const SAFE_TMP = realpathSync(tmpdir());
const CLOCK = { nowMs: () => NOW_MS };
const NOOP_AUDIT: AuditPort = { async writeAuthEvent() {} };

test("stored-DCR re-upgrade rejects rollback grants and preserves current sessions", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-dcr-rollback-"));
  const authFilename = join(dir, "auth.sqlite");
  const selected: HostedStoreConfig = {
    backend: "sqlite",
    stateDirectory: dir,
    authFilename,
    clientFilename: `${authFilename}.clients`,
  };
  const policy = {
    redirectAllowlist: [REDIRECT],
    scopeCatalog: ["fetch:read", "fetch:transform"],
  };
  const material = authMaterial();
  const verifier = randomBytes(48).toString("base64url");
  const currentCode = randomBytes(32).toString("base64url");
  let currentRefresh = "";

  try {
    const first = await createHostedAuthStore(selected, policy);
    await first.clientStore.save({
      clientId: EXISTING_CLIENT,
      redirectUris: [REDIRECT],
      applicationType: "web",
      issuedAtEpoch: Math.floor(NOW_MS / 1000),
    });
    const firstToken = tokenUseCase(material, first);
    await first.store.saveAuthCode({
      codeHash: sha256Hex(currentCode),
      clientId: EXISTING_CLIENT,
      subject: "subject",
      redirectUri: REDIRECT,
      resource: RESOURCE,
      scopes: ["fetch:read"],
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: "S256",
      expiresAt: FUTURE,
    });
    currentRefresh = (await firstToken.exchangeAuthorizationCode({
      grantType: "authorization_code",
      code: currentCode,
      redirectUri: REDIRECT,
      clientId: EXISTING_CLIENT,
      codeVerifier: verifier,
    })).refresh_token;
    await first.close();

    const rollbackGrants = seedRollbackGrants(authFilename, verifier);

    const upgraded = await createHostedAuthStore(selected, policy);
    assert.ok(
      await upgraded.clientStore.find(EXISTING_CLIENT),
      "the stored client survives the ordinary restart",
    );
    const upgradedToken = tokenUseCase(material, upgraded);
    const rotated = await upgradedToken.refresh({
      grantType: "refresh_token",
      refreshToken: currentRefresh,
      clientId: EXISTING_CLIENT,
    });
    assert.notEqual(
      rotated.refresh_token,
      currentRefresh,
      "a genuine generation-1 session survives restart",
    );

    for (const grant of rollbackGrants) {
      await assert.rejects(
        upgradedToken.exchangeAuthorizationCode({
          grantType: "authorization_code",
          code: grant.code,
          redirectUri: REDIRECT,
          clientId: grant.clientId,
          codeVerifier: verifier,
        }),
        invalidGrant,
        `${grant.clientId}: rollback authorization code`,
      );
      await assert.rejects(
        upgradedToken.refresh({
          grantType: "refresh_token",
          refreshToken: grant.refresh,
          clientId: grant.clientId,
        }),
        invalidGrant,
        `${grant.clientId}: rollback refresh family`,
      );
    }
    await upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tokenUseCase(
  material: ValidatedAuthMaterial,
  stores: Awaited<ReturnType<typeof createHostedAuthStore>>,
): OAuthTokenUseCase {
  return new OAuthTokenUseCase({
    config: createMcpSsoConfig(material, stores.clientStore),
    store: stores.store,
    clock: CLOCK,
    audit: NOOP_AUDIT,
  });
}

function authMaterial(): ValidatedAuthMaterial {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const config = createBridgeConfig({
    issuer: ISSUER,
    resource: RESOURCE,
    consentSigningSecret: randomBytes(32).toString("base64url"),
    signingPrivateJwk: {
      ...privateKey.export({ format: "jwk" }),
      alg: "ES256",
      kid: "rollback-key",
    } as JWK,
    signingKeyId: "rollback-key",
    redirectAllowlist: [REDIRECT],
    scopeCatalog: ["fetch:read", "fetch:transform"],
    defaultScopes: ["fetch:read"],
    allowedOrigins: ["https://client.test"],
    dcr: { mode: "stateless" },
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  });
  const {
    dcr: _dcr,
    clientCredentials: _clientCredentials,
    ...material
  } = config;
  return material;
}

function seedRollbackGrants(
  filename: string,
  verifier: string,
): Array<{ clientId: string; code: string; refresh: string }> {
  const db = new DatabaseSync(filename);
  try {
    return [UNKNOWN_CLIENT, EXISTING_CLIENT].map((clientId) => {
      const code = randomBytes(32).toString("base64url");
      const refresh = generateRefreshToken();
      const familyId = parseRefreshFamilyId(refresh);
      assert.ok(familyId);
      db.prepare(`INSERT INTO oauth_auth_codes (
        code_hash, client_id, subject, redirect_uri, resource, scopes_json,
        code_challenge, code_challenge_method, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sha256Hex(code),
        clientId,
        "subject",
        REDIRECT,
        RESOURCE,
        JSON.stringify(["fetch:read"]),
        pkceChallenge(verifier),
        "S256",
        FUTURE,
      );
      db.prepare(`INSERT INTO oauth_refresh_token_families (
        family_id, revoked_at
      ) VALUES (?, NULL)`).run(familyId);
      db.prepare(`INSERT INTO oauth_refresh_tokens (
        token_hash, family_id, previous_token_hash, client_id, subject,
        scopes_json, expires_at, consumed_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)`).run(
        sha256Hex(refresh),
        familyId,
        clientId,
        "subject",
        JSON.stringify(["fetch:read"]),
        FUTURE,
      );
      return { clientId, code, refresh };
    });
  } finally {
    db.close();
  }
}

function invalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === "invalid_grant";
}
