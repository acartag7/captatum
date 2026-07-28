import {
  assertAllowedRedirectUri,
  assertRegistrationRedirectPolicy,
  type ActiveClientSecrets,
  type UserClientRegistration,
  type VersionedMachineClientRegistration,
} from "mcp-sso";
import {
  asRecord,
  assertEpoch,
  assertExactKeys,
  assertPositiveEpoch,
  assertStringArray,
  parseJsonColumn,
} from "./client-store-codec-guards.ts";
import { assertSecrets } from "./client-store-secret-codec.ts";

const MACHINE_CLIENT_ID = /^mcc_[A-Za-z0-9_-]{1,200}$/;
const USER_CLIENT_ID = /^mcpdc_[A-Za-z0-9_-]{1,200}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const MAX_CLIENT_ID_LENGTH = 255;
const MAX_NAME_LENGTH = 255;
const MAX_REDIRECT_URIS = 16;
const MAX_SCOPES = 64;

export interface ClientCodecPolicy {
  redirectAllowlist: readonly string[];
  scopeCatalog: readonly string[];
}

export const CLIENT_ROW_KEYS = [
  "client_id",
  "application_type",
  "redirect_uris_json",
  "issued_at_epoch",
  "name",
  "allowed_scopes_json",
  "secrets_json",
  "status",
  "version",
  "disabled_at_epoch",
  "last_used_at_epoch",
  "updated_at_epoch",
] as const;

export interface SerializedClientRegistration {
  clientId: string;
  applicationType: "native" | "web" | "machine";
  redirectUrisJson: string;
  issuedAtEpoch: number;
  name: string | null;
  allowedScopesJson: string | null;
  secretsJson: string | null;
  status: "active" | "disabled" | null;
  version: number | null;
  disabledAtEpoch: number | null;
}

type PersistedClientRegistration =
  | UserClientRegistration
  | VersionedMachineClientRegistration;

export function parseClientRegistration(
  value: unknown,
  policy: ClientCodecPolicy,
): PersistedClientRegistration {
  const record = asRecord(value, "client registration");
  const type = record.applicationType;
  if (type === "native" || type === "web") return parseUserClient(record, type, policy);
  if (type === "machine") return parseMachineClient(record, policy);
  throw new Error("Stored client applicationType is invalid");
}

export function decodeClientRow(
  value: unknown,
  policy: ClientCodecPolicy,
): PersistedClientRegistration {
  const row = asRecord(value, "stored client row");
  assertExactKeys(row, [...CLIENT_ROW_KEYS]);
  assertEpoch(row.updated_at_epoch, "updated_at_epoch");
  assertEpoch(row.last_used_at_epoch, "last_used_at_epoch");
  const applicationType = row.application_type;
  const base = {
    clientId: row.client_id,
    applicationType,
    redirectUris: parseJsonColumn(row.redirect_uris_json, "redirect_uris_json"),
    issuedAtEpoch: row.issued_at_epoch,
  };
  if (applicationType === "native" || applicationType === "web") {
    if (
      row.name !== null || row.allowed_scopes_json !== null || row.secrets_json !== null
      || row.status !== null || row.version !== null || row.disabled_at_epoch !== null
    ) {
      throw new Error("Stored user client contains machine-only fields");
    }
    return parseClientRegistration(base, policy);
  }
  if (applicationType === "machine") {
    if (row.name !== null && typeof row.name !== "string") {
      throw new Error("Stored machine client name is invalid");
    }
    if (row.allowed_scopes_json === null || row.secrets_json === null) {
      throw new Error("Stored machine client is missing required fields");
    }
    return parseClientRegistration({
      ...base,
      ...(row.name === null ? {} : { name: row.name }),
      allowedScopes: parseJsonColumn(row.allowed_scopes_json, "allowed_scopes_json"),
      secrets: parseJsonColumn(row.secrets_json, "secrets_json"),
      status: row.status,
      version: row.version,
      ...(row.disabled_at_epoch === null ? {} : { disabledAtEpoch: row.disabled_at_epoch }),
    }, policy);
  }
  throw new Error("Stored client applicationType is invalid");
}

export function serializeClientRegistration(
  value: unknown,
  policy: ClientCodecPolicy,
): SerializedClientRegistration {
  const client = parseClientRegistration(value, policy);
  if (client.applicationType === "machine") {
    return {
      clientId: client.clientId,
      applicationType: client.applicationType,
      redirectUrisJson: JSON.stringify(client.redirectUris),
      issuedAtEpoch: client.issuedAtEpoch,
      name: client.name ?? null,
      allowedScopesJson: JSON.stringify(client.allowedScopes),
      secretsJson: JSON.stringify(client.secrets),
      status: client.status,
      version: client.version,
      disabledAtEpoch: client.status === "disabled" ? client.disabledAtEpoch : null,
    };
  }
  return {
    clientId: client.clientId,
    applicationType: client.applicationType,
    redirectUrisJson: JSON.stringify(client.redirectUris),
    issuedAtEpoch: client.issuedAtEpoch,
    name: null,
    allowedScopesJson: null,
    secretsJson: null,
    status: null,
    version: null,
    disabledAtEpoch: null,
  };
}

export function isFindableClientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CLIENT_ID_LENGTH;
}

function parseUserClient(
  record: Record<PropertyKey, unknown>,
  applicationType: "native" | "web",
  policy: ClientCodecPolicy,
): UserClientRegistration {
  assertExactKeys(record, ["clientId", "redirectUris", "applicationType", "issuedAtEpoch"]);
  const clientId = assertClientId(record.clientId);
  if (!USER_CLIENT_ID.test(clientId)) throw new Error("Stored user clientId is invalid");
  const redirectUris = assertStringArray(record.redirectUris, "redirectUris", 1, MAX_REDIRECT_URIS);
  for (const uri of redirectUris) {
    try {
      assertAllowedRedirectUri(uri, policy.redirectAllowlist);
      assertRegistrationRedirectPolicy(uri, applicationType);
    } catch {
      throw new Error("Stored user client redirect policy is invalid");
    }
  }
  assertEpoch(record.issuedAtEpoch, "issuedAtEpoch");
  return { clientId, redirectUris, applicationType, issuedAtEpoch: record.issuedAtEpoch as number };
}

function parseMachineClient(
  record: Record<PropertyKey, unknown>,
  policy: ClientCodecPolicy,
): VersionedMachineClientRegistration {
  assertExactKeys(
    record,
    [
      "clientId", "redirectUris", "applicationType", "issuedAtEpoch",
      "allowedScopes", "secrets", "status", "version",
    ],
    ["name", "disabledAtEpoch"],
  );
  const clientId = assertClientId(record.clientId);
  if (!MACHINE_CLIENT_ID.test(clientId)) throw new Error("Stored machine clientId is invalid");
  const redirectUris = assertStringArray(record.redirectUris, "redirectUris", 0, 0);
  assertEpoch(record.issuedAtEpoch, "issuedAtEpoch");
  const allowedScopes = assertStringArray(record.allowedScopes, "allowedScopes", 1, MAX_SCOPES);
  if (allowedScopes.some((scope) => !SCOPE_TOKEN.test(scope))) {
    throw new Error("Stored machine client scope is invalid");
  }
  const catalog = new Set(policy.scopeCatalog);
  if (allowedScopes.some((scope) => !catalog.has(scope))) {
    throw new Error("Stored machine client scope is outside the live catalog");
  }
  if (new Set(allowedScopes).size !== allowedScopes.length) {
    throw new Error("Stored machine client scopes contain duplicates");
  }
  const status = record.status;
  if (status !== "active" && status !== "disabled") {
    throw new Error("Stored machine client status is invalid");
  }
  assertPositiveEpoch(record.version, "version");
  const name = record.name;
  if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH)) {
    throw new Error("Stored machine client name is invalid");
  }
  const base = {
    clientId,
    redirectUris,
    applicationType: "machine" as const,
    issuedAtEpoch: record.issuedAtEpoch as number,
    ...(name === undefined ? {} : { name }),
    allowedScopes,
    version: record.version as number,
  };
  if (status === "active") {
    if (record.disabledAtEpoch !== undefined) {
      throw new Error("Stored active machine client has disable metadata");
    }
    return {
      ...base,
      status: "active",
      secrets: assertSecrets(record.secrets, "active") as ActiveClientSecrets,
    };
  }
  assertEpoch(record.disabledAtEpoch, "disabledAtEpoch");
  assertSecrets(record.secrets, "disabled");
  return {
    ...base,
    status: "disabled",
    secrets: [],
    disabledAtEpoch: record.disabledAtEpoch as number,
  };
}

function assertClientId(value: unknown): string {
  if (!isFindableClientId(value)) throw new Error("Stored clientId is invalid");
  return value;
}
