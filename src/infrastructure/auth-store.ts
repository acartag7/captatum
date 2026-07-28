import { chmodSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StorePort } from "mcp-sso";
import { openSqliteStore } from "mcp-sso/store/sqlite";
import { OAUTH_SCOPES } from "../application/scopes.ts";
import {
  openSqliteClientStore,
  type SqliteClientStore,
} from "./sqlite-client-store.ts";
import {
  prepareSqliteStateDirectory,
  resolveSqliteStorePaths,
  validateSqliteStorePaths,
  verifyOpenedSqliteFiles,
  type SqliteStorePaths,
} from "./sqlite-state-paths.ts";
import type { ClientCodecPolicy } from "./client-store-codec.ts";

export type AuthStoreBackend = "sqlite";
export type HostedStoreConfig = { backend: "sqlite" } & SqliteStorePaths;

export interface HostedAuthStore {
  store: StorePort;
  clientStore: SqliteClientStore;
  backend: AuthStoreBackend;
  close(): Promise<void>;
}

export const DEFAULT_CLIENT_CODEC_POLICY: ClientCodecPolicy = {
  redirectAllowlist: [],
  scopeCatalog: OAUTH_SCOPES,
};

const STORED_DCR_MIGRATION = "stored-dcr-v1";
const LEGACY_TABLES_IN_DELETE_ORDER = [
  "oauth_auth_codes",
  "oauth_refresh_tokens",
  "oauth_refresh_token_families",
] as const;
const INERT_LEGACY_TIDB_DEFAULTS = {
  TIDB_PORT: "4000",
  TIDB_DATABASE: "captatum",
  TIDB_USER: "captatum_rw",
} as const;
const TIDB_CREDENTIAL_ENV_NAMES = ["TIDB_PASSWORD", "TIDB_SSL_CA"] as const;

/** Resolve and validate the SQLite-only v0.20 backend before any side effect. */
export function resolveHostedStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedStoreConfig {
  assertSqliteOnlyTiDbConfig(env);
  const configuredPath = optionalEnv(env, "CAPTATUM_SQLITE_PATH")
    ?? "./data/captatum.sqlite";
  return { backend: "sqlite", ...resolveSqliteStorePaths(configuredPath) };
}

function assertSqliteOnlyTiDbConfig(env: NodeJS.ProcessEnv): void {
  const selected = optionalEnv(env, "TIDB_HOST") !== undefined;
  const nonLegacyDefault = Object.entries(INERT_LEGACY_TIDB_DEFAULTS)
    .some(([name, expected]) => {
      const value = optionalEnv(env, name);
      return value !== undefined && value !== expected;
    });
  const parkedCredential = TIDB_CREDENTIAL_ENV_NAMES
    .some((name) => optionalEnv(env, name) !== undefined);
  if (selected || nonLegacyDefault || parkedCredential) {
    throw new Error(
      "TiDB auth storage is deferred in v0.20; unset TIDB_HOST, credentials, CA, and non-default TIDB_* values",
    );
  }
}

/** Open OAuth + client stores after the full boot config and path policy passed. */
export async function createHostedAuthStore(
  selected: HostedStoreConfig = resolveHostedStoreConfig(),
  policy: ClientCodecPolicy = DEFAULT_CLIENT_CODEC_POLICY,
): Promise<HostedAuthStore> {
  validateSqliteStorePaths(selected);
  try {
    prepareSqliteStateDirectory(selected);
  } catch (error) {
    throw wrapStateDirectoryError(error, selected.authFilename);
  }
  runStoredDcrMigration(selected.authFilename);
  const store = openSqliteStore(selected.authFilename);
  let clientStore: SqliteClientStore | undefined;
  try {
    clientStore = openSqliteClientStore(selected.clientFilename, policy);
    verifyOpenedSqliteFiles(selected);
    return withOwnedClose({ store, clientStore, backend: "sqlite" }, [
      () => clientStore!.close(),
      () => store.close(),
    ]);
  } catch (error) {
    try { await clientStore?.close(); } catch { /* preserve open failure */ }
    try { await store.close(); } catch { /* preserve open failure */ }
    throw error;
  }
}

/** One-time, restart-safe cutover: no pre-stored-DCR grant survives the upgrade. */
export function runStoredDcrMigration(filename: string): void {
  if (filename === ":memory:") return;
  const db = new DatabaseSync(filename);
  try {
    if (process.platform !== "win32") chmodSync(filename, 0o600);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS captatum_schema_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT`);
      const applied = db.prepare(
        "SELECT 1 FROM captatum_schema_migrations WHERE migration_id = ?",
      ).get(STORED_DCR_MIGRATION);
      if (applied === undefined) {
        for (const table of LEGACY_TABLES_IN_DELETE_ORDER) {
          if (sqliteTableExists(db, table)) db.exec(`DELETE FROM ${table}`);
        }
        db.prepare(`INSERT INTO captatum_schema_migrations (
          migration_id, applied_at
        ) VALUES (?, ?)`).run(STORED_DCR_MIGRATION, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function withOwnedClose(
  stores: Omit<HostedAuthStore, "close">,
  closers: Array<() => Promise<void>>,
): HostedAuthStore {
  let closed = false;
  return {
    ...stores,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      let firstError: unknown;
      for (const close of closers) {
        try {
          await close();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

/** Self-diagnosing message for an unwritable private SQLite state directory. */
export function unwritableStoreDirMessage(
  file: string,
  code: string,
  user: string,
  cwd: string,
): string {
  const absParent = dirname(resolve(cwd, file));
  return (
    `SQLite state dir is not writable: cannot prepare ${absParent} ` +
    `(from CAPTATUM_SQLITE_PATH=${file}; running as ${user}, cwd ${cwd}, ` +
    `os error ${code}). Set CAPTATUM_SQLITE_PATH to a file inside a private ` +
    "writable directory (mode 0700), e.g. /data/captatum.sqlite."
  );
}

function wrapStateDirectoryError(error: unknown, file: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new Error(
      unwritableStoreDirMessage(file, code, safeUser(), process.cwd()),
    );
  }
  return error instanceof Error
    ? error
    : new Error("SQLite state directory preparation failed");
}

function optionalEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === ""
    ? undefined
    : value.trim();
}

function safeUser(): string {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}
