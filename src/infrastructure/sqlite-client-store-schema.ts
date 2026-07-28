import { DatabaseSync } from "node:sqlite";
import {
  OAuthError,
  type MachineClientMutationAudit,
} from "mcp-sso";
import type { SerializedClientRegistration } from "./client-store-codec.ts";

export const MAX_STORED_CLIENTS = 1024;
export const MAX_INTERACTIVE_CLIENTS = 1008;
export const MAX_ACTIVE_MACHINE_CLIENTS = 16;
export const INTERACTIVE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const CLIENT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  application_type TEXT NOT NULL CHECK(application_type IN ('native', 'web', 'machine')),
  redirect_uris_json TEXT NOT NULL,
  issued_at_epoch INTEGER NOT NULL,
  name TEXT,
  allowed_scopes_json TEXT,
  secrets_json TEXT,
  status TEXT CHECK(status IN ('active', 'disabled') OR status IS NULL),
  version INTEGER,
  disabled_at_epoch INTEGER,
  last_used_at_epoch INTEGER NOT NULL,
  updated_at_epoch INTEGER NOT NULL
) STRICT`;

const AUDIT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oauth_machine_client_audit (
  id INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN (
    'oauth.client.provision', 'oauth.client.rotate_secret', 'oauth.client.disable'
  )),
  client_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL
) STRICT`;

export function initializeClientSchema(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(CLIENT_TABLE_SQL);
  db.exec(AUDIT_TABLE_SQL);
}

export function insertMachineClient(
  db: DatabaseSync,
  value: SerializedClientRegistration,
): void {
  db.prepare(`INSERT INTO oauth_clients (
    client_id, application_type, redirect_uris_json, issued_at_epoch,
    name, allowed_scopes_json, secrets_json, status, version,
    disabled_at_epoch, last_used_at_epoch, updated_at_epoch
  ) VALUES (?, 'machine', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`).run(
    value.clientId,
    value.redirectUrisJson,
    value.issuedAtEpoch,
    value.name,
    value.allowedScopesJson,
    value.secretsJson,
    value.status,
    value.version,
    value.disabledAtEpoch,
  );
}

export function insertMachineAudit(
  db: DatabaseSync,
  audit: MachineClientMutationAudit,
): void {
  db.prepare(`INSERT INTO oauth_machine_client_audit (
    occurred_at, event, client_id, scopes_json
  ) VALUES (?, ?, ?, ?)`).run(
    audit.occurredAt,
    audit.event,
    audit.clientId,
    JSON.stringify(audit.scopes),
  );
}

export function assertClientCapacity(
  db: DatabaseSync,
  kind: "interactive" | "machine",
): void {
  if (count(db, "SELECT COUNT(*) AS count FROM oauth_clients") >= MAX_STORED_CLIENTS) {
    throw capacityError();
  }
  if (kind === "interactive") {
    const users = count(
      db,
      "SELECT COUNT(*) AS count FROM oauth_clients WHERE application_type != 'machine'",
    );
    if (users >= MAX_INTERACTIVE_CLIENTS) throw capacityError();
    return;
  }
  const machines = count(
    db,
    "SELECT COUNT(*) AS count FROM oauth_clients WHERE application_type = 'machine' AND status = 'active'",
  );
  if (machines >= MAX_ACTIVE_MACHINE_CLIENTS) throw capacityError();
}

export function clientExists(db: DatabaseSync, clientId: string): boolean {
  return db.prepare(
    "SELECT 1 FROM oauth_clients WHERE client_id = ?",
  ).get(clientId) !== undefined;
}

export function sweepStaleClients(db: DatabaseSync): number {
  const result = db.prepare(
    `DELETE FROM oauth_clients
     WHERE application_type != 'machine'
     AND last_used_at_epoch < unixepoch() - ?`,
  ).run(INTERACTIVE_RETENTION_SECONDS);
  return Number(result.changes);
}

export function sqliteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count?: unknown };
  return typeof row.count === "number" ? row.count : Number(row.count);
}

function capacityError(): OAuthError {
  return new OAuthError(
    "temporarily_unavailable",
    "Stored client capacity reached; retry after stale registrations expire",
    503,
  );
}
