import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type ActiveMachineClientRegistration,
  type ClientRegistration,
  type MachineClientMutationAudit,
  type MachineClientStore,
  type VersionedMachineClientRegistration,
} from "mcp-sso";
import {
  CLIENT_ROW_KEYS,
  decodeClientRow,
  isFindableClientId,
  serializeClientRegistration,
  type ClientCodecPolicy,
} from "./client-store-codec.ts";
import {
  assertClientCapacity,
  clientExists,
  initializeClientSchema,
  insertMachineAudit,
  insertMachineClient,
  sqliteTransaction,
  sweepStaleClients,
} from "./sqlite-client-store-schema.ts";
export {
  INTERACTIVE_RETENTION_SECONDS,
  MAX_ACTIVE_MACHINE_CLIENTS,
  MAX_INTERACTIVE_CLIENTS,
  MAX_STORED_CLIENTS,
} from "./sqlite-client-store-schema.ts";

const SELECT_COLUMNS = CLIENT_ROW_KEYS.join(", ");

export interface MachineClientSummary {
  clientId: string;
  name?: string;
  status: "active" | "disabled";
  allowedScopes: string[];
  version: number;
  issuedAtEpoch: number;
  disabledAtEpoch?: number;
}

export class SqliteClientStore implements MachineClientStore {
  private closed = false;
  private readonly db: DatabaseSync;
  private readonly policy: ClientCodecPolicy;
  private readonly ownsDatabase: boolean;

  constructor(
    db: DatabaseSync,
    policy: ClientCodecPolicy,
    ownsDatabase = false,
  ) {
    this.db = db;
    this.policy = policy;
    this.ownsDatabase = ownsDatabase;
    initializeClientSchema(this.db);
    sweepStaleClients(this.db);
  }

  async save(client: ClientRegistration): Promise<void> {
    this.ensureOpen();
    if (client.applicationType === "machine") {
      throw new Error("Machine clients require the atomic lifecycle methods");
    }
    const value = serializeClientRegistration(client, this.policy);
    this.transaction(() => {
      sweepStaleClients(this.db);
      if (clientExists(this.db, value.clientId)) {
        const existing = this.db.prepare(
          `SELECT ${SELECT_COLUMNS} FROM oauth_clients WHERE client_id = ?`,
        ).get(value.clientId);
        const persisted = existing === undefined
          ? undefined
          : serializeClientRegistration(
            decodeClientRow(existing, this.policy),
            this.policy,
          );
        if (
          persisted === undefined
          || persisted.applicationType !== value.applicationType
          || persisted.redirectUrisJson !== value.redirectUrisJson
          || persisted.issuedAtEpoch !== value.issuedAtEpoch
        ) {
          throw new Error("Stored DCR client identifier collision");
        }
        return;
      }
      assertClientCapacity(this.db, "interactive");
      this.db.prepare(`INSERT INTO oauth_clients (
        client_id, application_type, redirect_uris_json, issued_at_epoch,
        name, allowed_scopes_json, secrets_json, status, version,
        disabled_at_epoch, last_used_at_epoch, updated_at_epoch
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, unixepoch(), unixepoch())
      `).run(
        value.clientId,
        value.applicationType,
        value.redirectUrisJson,
        value.issuedAtEpoch,
      );
    });
  }

  async createMachineClient(
    client: ActiveMachineClientRegistration,
    audit: MachineClientMutationAudit,
  ): Promise<boolean> {
    this.ensureOpen();
    const value = serializeClientRegistration(client, this.policy);
    return this.transaction(() => {
      if (clientExists(this.db, value.clientId)) return false;
      assertClientCapacity(this.db, "machine");
      insertMachineClient(this.db, value);
      insertMachineAudit(this.db, audit);
      return true;
    });
  }

  async compareAndSwapMachineClient(
    expectedVersion: number,
    client: VersionedMachineClientRegistration,
    audit: MachineClientMutationAudit,
  ): Promise<boolean> {
    this.ensureOpen();
    const value = serializeClientRegistration(client, this.policy);
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE oauth_clients SET
        redirect_uris_json = ?, issued_at_epoch = ?, name = ?,
        allowed_scopes_json = ?, secrets_json = ?, status = ?, version = ?,
        disabled_at_epoch = ?, updated_at_epoch = unixepoch()
        WHERE client_id = ? AND application_type = 'machine' AND version = ?`).run(
        value.redirectUrisJson,
        value.issuedAtEpoch,
        value.name,
        value.allowedScopesJson,
        value.secretsJson,
        value.status,
        value.version,
        value.disabledAtEpoch,
        value.clientId,
        expectedVersion,
      );
      if (Number(result.changes) !== 1) return false;
      insertMachineAudit(this.db, audit);
      return true;
    });
  }

  async find(clientId: string): Promise<ClientRegistration | null> {
    this.ensureOpen();
    if (!isFindableClientId(clientId)) return null;
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM oauth_clients WHERE client_id = ?`,
    ).get(clientId);
    if (row === undefined) return null;
    try {
      const client = decodeClientRow(row, this.policy);
      if (client.applicationType !== "machine") {
        this.db.prepare(
          "UPDATE oauth_clients SET last_used_at_epoch = unixepoch() WHERE client_id = ?",
        ).run(clientId);
      }
      return client;
    } catch {
      return null;
    }
  }

  async listMachineClients(): Promise<MachineClientSummary[]> {
    this.ensureOpen();
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM oauth_clients
       WHERE application_type = 'machine' ORDER BY client_id`,
    ).all();
    const out: MachineClientSummary[] = [];
    for (const row of rows) {
      try {
        const client = decodeClientRow(row, this.policy);
        if (client.applicationType !== "machine") continue;
        out.push({
          clientId: client.clientId,
          ...(client.name === undefined ? {} : { name: client.name }),
          status: client.status,
          allowedScopes: [...client.allowedScopes],
          version: client.version,
          issuedAtEpoch: client.issuedAtEpoch,
          ...(client.status === "disabled"
            ? { disabledAtEpoch: client.disabledAtEpoch }
            : {}),
        });
      } catch {
        // A poisoned row never becomes an operator-visible valid client.
      }
    }
    return out;
  }

  async sweepStaleClients(): Promise<number> {
    this.ensureOpen();
    return sweepStaleClients(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDatabase) this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    return sqliteTransaction(this.db, fn);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("ClientStore is closed");
  }
}

export function openSqliteClientStore(
  filename: string,
  policy: ClientCodecPolicy,
): SqliteClientStore {
  const database = new DatabaseSync(filename);
  try {
    lockClientStoreFile(filename);
    return new SqliteClientStore(database, policy, true);
  } catch (error) {
    try { database.close(); } catch { /* preserve the open failure */ }
    throw error;
  }
}

function lockClientStoreFile(filename: string): void {
  if (filename === ":memory:" || process.platform === "win32") return;
  try {
    chmodSync(filename, 0o600);
  } catch {
    throw new Error("sqlite client store: cannot enforce file mode 0600");
  }
}
