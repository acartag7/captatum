import { createHmac } from "node:crypto";
import type { JWK } from "jose";
import {
  AuthConfigError,
  createBridgeConfig,
  type BridgeConfig,
  type ClientStore,
} from "mcp-sso";
import { config } from "../config.ts";
import { envStrictBoolean } from "../env-parsing.ts";
import { OAUTH_SCOPES } from "./scopes.ts";

export type DeploymentFlavor = "hosted" | "local-binary";
export type ValidatedAuthMaterial = Omit<BridgeConfig, "dcr" | "clientCredentials">;

/** Pure auth resolution. Hosted material is fully validated before any store is opened. */
export interface CaptatumAuthRuntime {
  flavor: DeploymentFlavor;
  readonly material?: ValidatedAuthMaterial;
}

export function loadCaptatumAuth(env: NodeJS.ProcessEnv = process.env): CaptatumAuthRuntime {
  const flavor = readFlavor(env);
  if (flavor === "local-binary") return { flavor };
  assertHostedCloudflareAccess(env);
  return { flavor, material: validateMcpSsoMaterial(env) };
}

/** Compose the final store-backed config only after the persistent ClientStore exists. */
export function createMcpSsoConfig(
  material: ValidatedAuthMaterial,
  clientStore: ClientStore,
): BridgeConfig {
  return createBridgeConfig({
    ...material,
    consentSigningSecret: createHmac(
      "sha256",
      material.consentSigningSecret,
    ).update("captatum:stored-dcr:v1").digest("base64url"),
    dcr: { mode: "stored", store: clientStore },
    clientCredentials: { enabled: true },
  });
}

/** Read + validate the deployment flavor. Only explicit hosted enables network OAuth. */
export function readFlavor(env: NodeJS.ProcessEnv = process.env): DeploymentFlavor {
  const raw = env.CAPTATUM_FLAVOR ?? env.DEPLOYMENT_FLAVOR ?? "local-binary";
  if (raw === "hosted" || raw === "local-binary") return raw;
  throw new AuthConfigError("CAPTATUM_FLAVOR must be hosted or local-binary");
}

/** Validate all OAuth material without a filesystem/database-backed ClientStore. */
export function validateMcpSsoMaterial(
  env: NodeJS.ProcessEnv = process.env,
): ValidatedAuthMaterial {
  const validated = createBridgeConfig({
    issuer: mustEnv(env, "OAUTH_ISSUER"),
    resource: mustEnv(env, "OAUTH_RESOURCE"),
    consentSigningSecret: mustEnv(env, "OAUTH_CONSENT_SIGNING_SECRET"),
    signingPrivateJwk: parsePrivateJwk(mustEnv(env, "OAUTH_SIGNING_PRIVATE_JWK")),
    signingKeyId: mustEnv(env, "OAUTH_SIGNING_KEY_ID"),
    redirectAllowlist: mustListEnv(env, "OAUTH_REDIRECT_ALLOWLIST"),
    scopeCatalog: [...OAUTH_SCOPES],
    defaultScopes: [OAUTH_SCOPES[0]],
    allowedOrigins: mustListEnv(env, "MCP_ALLOWED_ORIGINS"),
    dcr: { mode: "stateless" },
    cimd: { enabled: true },
    dev: envString(env, "OAUTH_ALLOW_INSECURE_LOCALHOST") === "true"
      ? { allowInsecureLocalhost: true }
      : undefined,
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    consentTokenTtlSeconds: config.oauth.consentTokenTtlSeconds,
    authorizationCodeTtlSeconds: config.oauth.authorizationCodeTtlSeconds,
  });
  const { dcr: _dcr, clientCredentials: _clientCredentials, ...material } = validated;
  return Object.freeze(material);
}

/** Hosted authorization requires a verified Cloudflare Access identity. */
export function assertHostedCloudflareAccess(env: NodeJS.ProcessEnv = process.env): void {
  // Same strict parse as config.cloudflareAccess.enabled(): trim first (ConfigMap
  // contamination), then exact literals — this gate runs BEFORE any config.ts
  // accessor, so a raw `=== "true"` here silently rejected values the selector
  // contract calls valid (" true ") and accepted nothing the parser rejects.
  const enabled = envStrictBoolean("CF_ACCESS_ENABLED", false, env);
  const audience = env.CF_ACCESS_AUDIENCE?.trim();
  const certsUrl = env.CF_ACCESS_CERTS_URL?.trim();
  const issuer = env.CF_ACCESS_ISSUER?.trim();
  if (!enabled || !audience || !certsUrl || !issuer) {
    throw new AuthConfigError(
      "Hosted flavor requires Cloudflare Access: CF_ACCESS_ENABLED=true plus CF_ACCESS_AUDIENCE, CF_ACCESS_CERTS_URL, CF_ACCESS_ISSUER",
    );
  }
  assertHttpsUrl(certsUrl, "CF_ACCESS_CERTS_URL");
  assertHttpsUrl(issuer, "CF_ACCESS_ISSUER");
}

function assertHttpsUrl(raw: string, label: string): void {
  if (!/^https:\/\//i.test(raw)) throw new AuthConfigError(`${label} must be an absolute https URL`);
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.host) throw new Error("not absolute");
  } catch {
    throw new AuthConfigError(`${label} must be an absolute https URL`);
  }
}

function mustEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new AuthConfigError(`Hosted requires ${name}`);
  return value;
}

function envString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value && value.trim() ? value : "";
}

function mustListEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  const values = mustEnv(env, name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) throw new AuthConfigError(`Hosted requires ${name}`);
  return values;
}

function parsePrivateJwk(raw: string): JWK {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JWK;
  } catch (error) {
    throw new AuthConfigError(
      `OAUTH_SIGNING_PRIVATE_JWK must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
}
