import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JWK } from "jose";
import { startHostedServer } from "../src/server.ts";

const SAFE_TMP = realpathSync(tmpdir());

test("missing trusted-proxy config aborts before creating SQLite state", async () => {
  const parent = join(SAFE_TMP, `captatum-proxy-gate-${randomUUID()}`);
  const file = join(parent, "auth.sqlite");
  const restore = installHostedEnv(file, "cidrs");
  try {
    await assert.rejects(
      startHostedServer({ host: "127.0.0.1", port: 0, log: () => {} }),
      /CAPTATUM_TRUSTED_PROXY_CIDRS is required/,
    );
    assert.equal(
      existsSync(parent),
      false,
      "the reverse-proxy trust boundary is validated before state preparation",
    );
  } finally {
    restore();
  }
});

test("missing proxy authenticator aborts before creating SQLite state", async () => {
  const parent = join(SAFE_TMP, `captatum-proxy-secret-${randomUUID()}`);
  const file = join(parent, "auth.sqlite");
  const restore = installHostedEnv(file, "secret");
  try {
    await assert.rejects(
      startHostedServer({ host: "127.0.0.1", port: 0, log: () => {} }),
      /CAPTATUM_PROXY_AUTH_SECRET/,
    );
    assert.equal(existsSync(parent), false);
  } finally {
    restore();
  }
});

test("invalid CDP origin aborts before creating SQLite state", async () => {
  const parent = join(SAFE_TMP, `captatum-cdp-gate-${randomUUID()}`);
  const file = join(parent, "auth.sqlite");
  const restore = installHostedEnv(file, undefined, {
    CAPTATUM_BROWSER_CDP_ENDPOINT: "http://browser.example.com:9222",
  });
  try {
    await assert.rejects(
      startHostedServer({ host: "127.0.0.1", port: 0, log: () => {} }),
      /CAPTATUM_BROWSER_CDP_ENDPOINT is not an allowed CDP origin/,
    );
    assert.equal(existsSync(parent), false);
  } finally {
    restore();
  }
});

function installHostedEnv(
  file: string,
  missing?: "cidrs" | "secret",
  overrides: Record<string, string> = {},
): () => void {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const values: Record<string, string> = {
    CAPTATUM_FLAVOR: "hosted",
    CAPTATUM_SQLITE_PATH: file,
    CAPTATUM_BULK_ENABLED: "false",
    OAUTH_ISSUER: "https://captatum.test",
    OAUTH_RESOURCE: "https://captatum.test/mcp",
    OAUTH_CONSENT_SIGNING_SECRET: randomBytes(32).toString("hex"),
    OAUTH_SIGNING_PRIVATE_JWK: JSON.stringify({
      ...privateKey.export({ format: "jwk" }),
      alg: "ES256",
      kid: "proxy-gate-key",
    } as JWK),
    OAUTH_SIGNING_KEY_ID: "proxy-gate-key",
    OAUTH_REDIRECT_ALLOWLIST: "https://client.test/callback",
    MCP_ALLOWED_HOSTS: "captatum.test",
    MCP_ALLOWED_ORIGINS: "https://client.test",
    CAPTATUM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    CAPTATUM_PROXY_AUTH_SECRET: randomBytes(32).toString("base64url"),
    CF_ACCESS_ENABLED: "true",
    CF_ACCESS_AUDIENCE: "test-audience",
    CF_ACCESS_CERTS_URL:
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    CF_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
    ...overrides,
  };
  const cleared = [
    ...(missing === "cidrs" ? ["CAPTATUM_TRUSTED_PROXY_CIDRS"] : []),
    ...(missing === "secret" ? ["CAPTATUM_PROXY_AUTH_SECRET"] : []),
    "TIDB_HOST",
    "TIDB_PORT",
    "TIDB_DATABASE",
    "TIDB_USER",
    "TIDB_PASSWORD",
    "TIDB_SSL_CA",
  ];
  const names = [...Object.keys(values), ...cleared];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  for (const name of cleared) delete process.env[name];
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
