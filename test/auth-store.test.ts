// Regression coverage for src/infrastructure/auth-store.ts — the hosted OAuth-state store
// factory. v0.20 rejects every TiDB selector before side effects; SQLite private-state
// creation/modes, independent files, and the one-time migration are exercised here.
// (Non-frozen: this guards implementation details.)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSqliteStore } from "mcp-sso/store/sqlite";
import {
  createHostedAuthStore,
  resolveHostedStoreConfig,
  runStoredDcrMigration,
  unwritableStoreDirMessage,
} from "../src/infrastructure/auth-store.ts";
import { verifyOpenedSqliteFiles } from "../src/infrastructure/sqlite-state-paths.ts";

const SAFE_TMP = realpathSync(tmpdir());
const TEST_POLICY = {
  redirectAllowlist: ["https://client.test"],
  scopeCatalog: ["fetch:read", "fetch:transform"],
};

const TIDB_ENV = {
  TIDB_HOST: "tidb.test", TIDB_PORT: "4000", TIDB_DATABASE: "captatum",
  TIDB_USER: "u", TIDB_PASSWORD: randomBytes(16).toString("hex"),
};

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("v0.20 rejects every non-empty TiDB selector before opening state", async () => {
  await withEnv({ ...TIDB_ENV, TIDB_SSL_CA: "ca" }, async () => {
    assert.throws(() => resolveHostedStoreConfig(), /TiDB auth storage is deferred/);
  });
});

test("a parked TiDB credential without TIDB_HOST still fails closed", () => {
  assert.throws(() => resolveHostedStoreConfig({
    TIDB_HOST: "",
    TIDB_PASSWORD: randomBytes(16).toString("hex"),
    CAPTATUM_SQLITE_PATH: "/must/not/be/created",
  }), /unset every TIDB_/);
});

test("SQLite defaults to two persistent 0600 files with independent locks and restart persistence", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-auth-store-"));
  const file = join(dir, "nested", "auth.sqlite");
  const clientFile = `${file}.clients`;
  const client = {
    clientId: "mcpdc_separate_file_client",
    redirectUris: ["https://client.test/callback"],
    applicationType: "web" as const,
    issuedAtEpoch: Math.floor(Date.now() / 1000),
  };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  try {
    await withEnv({ TIDB_HOST: undefined, CAPTATUM_SQLITE_PATH: file }, async () => {
      const selected = resolveHostedStoreConfig();
      assert.deepEqual(selected, {
        backend: "sqlite", stateDirectory: join(dir, "nested"),
        authFilename: file, clientFilename: clientFile,
      });
      const stores = await createHostedAuthStore(selected, TEST_POLICY);
      assert.ok(existsSync(file));
      assert.ok(existsSync(clientFile));
      assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
      if (process.platform !== "win32") {
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(clientFile).mode & 0o777, 0o600);
      }
      await stores.store.saveAuthCode({
        codeHash: "a".repeat(64), clientId: client.clientId, subject: "operator@test",
        redirectUri: client.redirectUris[0], resource: "https://captatum.test/mcp",
        scopes: ["fetch:read"], codeChallenge: "challenge", codeChallengeMethod: "S256", expiresAt,
      });
      const authLock = new DatabaseSync(file);
      authLock.exec("BEGIN IMMEDIATE");
      try {
        await stores.clientStore.save(client);
        authLock.exec("COMMIT");
      } catch (error) {
        authLock.exec("ROLLBACK");
        throw error;
      } finally {
        authLock.close();
      }
      const clientLock = new DatabaseSync(clientFile);
      clientLock.exec("BEGIN IMMEDIATE");
      try {
        await stores.store.saveAuthCode({
          codeHash: "b".repeat(64), clientId: client.clientId, subject: "operator@test",
          redirectUri: client.redirectUris[0], resource: "https://captatum.test/mcp",
          scopes: ["fetch:read"], codeChallenge: "challenge-2", codeChallengeMethod: "S256", expiresAt,
        });
        clientLock.exec("COMMIT");
      } catch (error) {
        clientLock.exec("ROLLBACK");
        throw error;
      } finally {
        clientLock.close();
      }
      await stores.close();
      await assert.rejects(stores.store.sweepExpired(new Date().toISOString()), /closed/i);
      await assert.rejects(stores.clientStore.find(client.clientId), /closed/i);

      const reopened = await createHostedAuthStore(selected, TEST_POLICY);
      assert.deepEqual(await reopened.clientStore.find(client.clientId), client);
      assert.ok(await reopened.store.consumeAuthCode("a".repeat(64), new Date().toISOString()));
      await reopened.close();
    });
    const source = readFileSync(new URL("../src/infrastructure/auth-store.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /Reflect\.get|\[.?["']db["']\]?/, "composition uses no private mcp-sso fields");
    assert.match(source, /verifyOpenedSqliteFiles\(selected\)/, "post-open inode/mode defense stays wired");
    const serverSource = readFileSync(
      new URL("../src/server-runtime.ts", import.meta.url),
      "utf8",
    );
    const cliSource = readFileSync(new URL("../src/machine-client.ts", import.meta.url), "utf8");
    assert.match(serverSource, /resolveHostedStoreConfig\(\)/);
    assert.match(cliSource, /resolveHostedStoreConfig\(options\.env/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite path validation preserves paired :memory: tests and rejects aliases before creation", async () => {
  const memory = resolveHostedStoreConfig({ TIDB_HOST: "", CAPTATUM_SQLITE_PATH: ":memory:" });
  assert.deepEqual(memory, {
    backend: "sqlite", stateDirectory: ":memory:",
    authFilename: ":memory:", clientFilename: ":memory:",
  });
  const memoryStores = await createHostedAuthStore(memory, TEST_POLICY);
  await memoryStores.clientStore.save({
    clientId: "mcpdc_memory_client", redirectUris: ["https://client.test/callback"],
    applicationType: "web", issuedAtEpoch: 1_800_000_000,
  });
  await memoryStores.close();

  const dir = mkdtempSync(join(SAFE_TMP, "captatum-store-paths-"));
  try {
    const same = join(dir, "same.sqlite");
    await assert.rejects(
      createHostedAuthStore({
        backend: "sqlite", stateDirectory: dir, authFilename: same, clientFilename: same,
      }),
      /different files/,
    );
    assert.equal(existsSync(same), false, "equal-path rejection happens before file creation");

    const wideState = join(dir, "wide-state");
    mkdirSync(wideState, { mode: 0o755 });
    chmodSync(wideState, 0o755);
    assert.throws(
      () => resolveHostedStoreConfig({
        TIDB_HOST: "", CAPTATUM_SQLITE_PATH: join(wideState, "auth.sqlite"),
      }),
      /mode 0700/,
    );

    const nonDirectory = join(dir, "not-a-directory");
    writeFileSync(nonDirectory, "x");
    assert.throws(
      () => resolveHostedStoreConfig({
        TIDB_HOST: "", CAPTATUM_SQLITE_PATH: join(nonDirectory, "auth.sqlite"),
      }),
      /must be a directory/,
    );

    const looseAuth = join(dir, "loose.sqlite");
    writeFileSync(looseAuth, "");
    chmodSync(looseAuth, 0o644);
    await assert.rejects(
      createHostedAuthStore({
        backend: "sqlite", stateDirectory: dir,
        authFilename: looseAuth, clientFilename: `${looseAuth}.clients`,
      }),
      /mode 0600/,
    );

    const hardAuth = join(dir, "hard-auth.sqlite");
    const hardClient = join(dir, "hard-client.sqlite");
    writeFileSync(hardAuth, "");
    chmodSync(hardAuth, 0o600);
    linkSync(hardAuth, hardClient);
    const hardLinkedPaths = {
      stateDirectory: dir, authFilename: hardAuth, clientFilename: hardClient,
    };
    assert.throws(
      () => verifyOpenedSqliteFiles(hardLinkedPaths),
      /same inode/,
      "post-open defense rejects aliases even if pre-open checks were raced",
    );
    await assert.rejects(
      createHostedAuthStore({ backend: "sqlite", ...hardLinkedPaths }),
      /same inode/,
    );

    if (process.platform !== "win32") {
      const realState = join(dir, "real-state");
      const stateLink = join(dir, "state-link");
      mkdirSync(realState, { mode: 0o700 });
      symlinkSync(realState, stateLink);
      assert.throws(
        () => resolveHostedStoreConfig({
          TIDB_HOST: "", CAPTATUM_SQLITE_PATH: join(stateLink, "auth.sqlite"),
        }),
        /path component must not be a symlink/,
      );

      const target = join(dir, "target.sqlite");
      const link = join(dir, "client-link.sqlite");
      writeFileSync(target, "");
      symlinkSync(target, link);
      await assert.rejects(
        createHostedAuthStore({
          backend: "sqlite", stateDirectory: dir,
          authFilename: join(dir, "auth.sqlite"), clientFilename: link,
        }),
        /symbolic link/,
      );
      assert.equal(existsSync(join(dir, "auth.sqlite")), false, "symlink rejection precedes auth-file creation");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unwritableStoreDirMessage names the resolved path, the env var, the user, and the fix", () => {
  const msg = unwritableStoreDirMessage("/app/data/captatum.sqlite", "EACCES", "node", "/app");
  assert.match(msg, /\/app\/data/); // the resolved parent dir
  assert.match(msg, /CAPTATUM_SQLITE_PATH/); // the env knob to turn
  assert.match(msg, /\bnode\b/); // the running user
  assert.match(msg, /private writable directory/); // the actionable remedy
});

test("stored-DCR migration atomically purges legacy codes and refresh families once", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-auth-migration-"));
  const file = join(dir, "auth.sqlite");
  try {
    const legacy = openSqliteStore(file);
    const codeHash = "a".repeat(64);
    const refreshHash = "b".repeat(64);
    await legacy.saveAuthCode({
      codeHash,
      clientId: "legacy-client",
      subject: "legacy-subject",
      redirectUri: "https://client.test/callback",
      resource: "https://captatum.test/mcp",
      scopes: ["fetch:read"],
      codeChallenge: "legacy-challenge",
      codeChallengeMethod: "S256",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await legacy.saveRefreshToken({
      tokenHash: refreshHash,
      familyId: "legacy-family",
      previousTokenHash: null,
      clientId: "legacy-client",
      subject: "legacy-subject",
      scopes: ["fetch:read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await legacy.close();

    runStoredDcrMigration(file);
    const store = openSqliteStore(file);
    assert.equal(await store.findRefreshToken(refreshHash), null);
    assert.equal(
      await store.consumeAuthCode(codeHash, "2026-07-27T00:00:00.000Z"),
      null,
    );
    await store.close();
    const migrated = new DatabaseSync(file);
    for (const table of [
      "oauth_auth_codes",
      "oauth_refresh_tokens",
      "oauth_refresh_token_families",
    ]) {
      assert.equal(
        (migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
      );
    }
    assert.equal(
      (migrated.prepare(
        "SELECT COUNT(*) AS count FROM captatum_schema_migrations WHERE migration_id = 'stored-dcr-v1'",
      ).get() as { count: number }).count,
      1,
    );
    migrated.exec(`INSERT INTO oauth_auth_codes (
      code_hash, client_id, subject, redirect_uri, resource, scopes_json,
      code_challenge, code_challenge_method, expires_at
    ) VALUES (
      '${"c".repeat(64)}', 'stored-client', 'subject',
      'https://client.test/callback', 'https://captatum.test/mcp',
      '["fetch:read"]', 'challenge', 'S256', '2027-01-01T00:00:00.000Z'
    )`);
    migrated.close();
    runStoredDcrMigration(file);
    const reopened = new DatabaseSync(file, { readOnly: true });
    assert.equal(
      (reopened.prepare("SELECT COUNT(*) AS count FROM oauth_auth_codes").get() as { count: number }).count,
      1,
      "the durable marker prevents a later boot from deleting stored-DCR-era state",
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored-DCR migration rolls every purge back if any legacy delete fails", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-auth-migration-rollback-"));
  const file = join(dir, "auth.sqlite");
  try {
    const legacy = openSqliteStore(file);
    await legacy.saveAuthCode({
      codeHash: "d".repeat(64),
      clientId: "legacy-client",
      subject: "legacy-subject",
      redirectUri: "https://client.test/callback",
      resource: "https://captatum.test/mcp",
      scopes: ["fetch:read"],
      codeChallenge: "legacy-challenge",
      codeChallengeMethod: "S256",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await legacy.saveRefreshToken({
      tokenHash: "e".repeat(64),
      familyId: "legacy-family",
      previousTokenHash: null,
      clientId: "legacy-client",
      subject: "legacy-subject",
      scopes: ["fetch:read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await legacy.close();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TRIGGER reject_legacy_refresh_delete
      BEFORE DELETE ON oauth_refresh_tokens
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    db.close();

    assert.throws(() => runStoredDcrMigration(file), /injected migration failure/);
    const checked = new DatabaseSync(file, { readOnly: true });
    assert.equal(
      (checked.prepare("SELECT COUNT(*) AS count FROM oauth_auth_codes").get() as { count: number }).count,
      1,
      "the earlier auth-code delete rolled back",
    );
    assert.equal(
      (checked.prepare("SELECT COUNT(*) AS count FROM oauth_refresh_tokens").get() as { count: number }).count,
      1,
    );
    assert.equal(
      checked.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'captatum_schema_migrations'",
      ).get(),
      undefined,
      "a failed first migration also rolls back marker-table creation",
    );
    checked.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
