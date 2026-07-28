import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ActiveMachineClientRegistration,
  MachineClientMutationAudit,
  UserClientRegistration,
  VersionedMachineClientRegistration,
} from "mcp-sso";
import {
  decodeClientRow,
  type ClientCodecPolicy,
} from "../src/infrastructure/client-store-codec.ts";
import {
  MAX_INTERACTIVE_CLIENTS,
  openSqliteClientStore,
} from "../src/infrastructure/sqlite-client-store.ts";

const POLICY: ClientCodecPolicy = {
  redirectAllowlist: ["https://client.test/callback"],
  scopeCatalog: ["fetch:read", "fetch:transform"],
};

function hash(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

function machineClient(): ActiveMachineClientRegistration {
  return {
    clientId: `mcc_${randomUUID().replaceAll("-", "")}`,
    redirectUris: [],
    applicationType: "machine",
    issuedAtEpoch: 1_800_000_000,
    name: "nightly-fetch",
    allowedScopes: ["fetch:read"],
    status: "active",
    version: 1,
    secrets: [{ hash: hash(), createdAtEpoch: 1_800_000_000 }],
  };
}

function userClient(index = 0): UserClientRegistration {
  return {
    clientId: `mcpdc_${index}_${randomUUID().replaceAll("-", "")}`,
    redirectUris: ["https://client.test/callback"],
    applicationType: "web",
    issuedAtEpoch: Math.floor(Date.now() / 1000),
  };
}

function audit(
  client: ActiveMachineClientRegistration,
): MachineClientMutationAudit {
  return {
    occurredAt: new Date().toISOString(),
    event: "oauth.client.provision",
    clientId: client.clientId,
    scopes: client.allowedScopes,
  };
}

test("SQLite ClientStore persists DCR + atomically audited machine clients", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-client-store-"));
  const file = join(dir, "clients.sqlite");
  const machine = machineClient();
  const user = userClient();
  try {
    const first = openSqliteClientStore(file, POLICY);
    await first.save(user);
    assert.equal(await first.createMachineClient(machine, audit(machine)), true);
    await first.close();

    const second = openSqliteClientStore(file, POLICY);
    assert.deepEqual(await second.find(user.clientId), user);
    assert.deepEqual(await second.find(machine.clientId), machine);
    await second.close();
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      "SELECT event, client_id FROM oauth_machine_client_audit",
    ).all();
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event, "oauth.client.provision");
    assert.equal(rows[0]?.client_id, machine.clientId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted codec rejects redirect-policy and secret-row poisoning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-client-poison-"));
  const file = join(dir, "clients.sqlite");
  const store = openSqliteClientStore(file, POLICY);
  const db = new DatabaseSync(file);
  try {
    const user = userClient();
    await store.save(user);
    db.prepare(
      "UPDATE oauth_clients SET redirect_uris_json = ? WHERE client_id = ?",
    ).run(JSON.stringify(["https://attacker.test/callback"]), user.clientId);
    assert.equal(await store.find(user.clientId), null);

    const machine = machineClient();
    await store.createMachineClient(machine, audit(machine));
    db.prepare(
      "UPDATE oauth_clients SET secrets_json = ? WHERE client_id = ?",
    ).run(
      JSON.stringify([{ ...machine.secrets[0], unexpected: true }]),
      machine.clientId,
    );
    assert.equal(await store.find(machine.clientId), null);
  } finally {
    db.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored-DCR cap rejects the flood and leaves existing clients usable", async () => {
  const store = openSqliteClientStore(":memory:", POLICY);
  try {
    let first: UserClientRegistration | undefined;
    for (let index = 0; index < MAX_INTERACTIVE_CLIENTS; index++) {
      const client = userClient(index);
      first ??= client;
      await store.save(client);
    }
    const overflow = userClient(MAX_INTERACTIVE_CLIENTS);
    await assert.rejects(
      store.save(overflow),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "temporarily_unavailable");
        assert.equal((error as { status?: number }).status, 503);
        return true;
      },
    );
    assert.deepEqual(await store.find(first!.clientId), first);
    assert.equal(await store.find(overflow.clientId), null);
  } finally {
    await store.close();
  }
});

test("stale interactive sweep removes old DCR rows but retains machine tombstones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-client-retention-"));
  const file = join(dir, "clients.sqlite");
  const store = openSqliteClientStore(file, POLICY);
  const db = new DatabaseSync(file);
  try {
    const user = userClient();
    const machine = machineClient();
    await store.save(user);
    await store.createMachineClient(machine, audit(machine));
    db.prepare(
      "UPDATE oauth_clients SET last_used_at_epoch = 1 WHERE client_id IN (?, ?)",
    ).run(user.clientId, machine.clientId);
    assert.equal(await store.sweepStaleClients(), 1);
    assert.equal(await store.find(user.clientId), null);
    assert.deepEqual(await store.find(machine.clientId), machine);
  } finally {
    db.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machine mutation rolls the credential row back when durable audit insert fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-client-audit-rollback-"));
  const file = join(dir, "clients.sqlite");
  const store = openSqliteClientStore(file, POLICY);
  const db = new DatabaseSync(file);
  const machine = machineClient();
  try {
    db.exec(`CREATE TRIGGER reject_machine_audit
      BEFORE INSERT ON oauth_machine_client_audit
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
    await assert.rejects(
      store.createMachineClient(machine, audit(machine)),
      /injected audit failure/,
    );
    assert.equal(await store.find(machine.clientId), null);
  } finally {
    db.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machine CAS rolls rotate and disable back when durable audit insert fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-client-cas-audit-"));
  const file = join(dir, "clients.sqlite");
  const store = openSqliteClientStore(file, POLICY);
  const db = new DatabaseSync(file);
  const original = machineClient();
  const now = original.issuedAtEpoch;
  const rotated: VersionedMachineClientRegistration = {
    ...original,
    version: 2,
    secrets: [
      { hash: hash(), createdAtEpoch: now + 1 },
      { ...original.secrets[0], expiresAtEpoch: now + 10 },
    ],
  };
  try {
    await store.createMachineClient(original, audit(original));
    db.exec(`CREATE TRIGGER reject_rotate_audit
      BEFORE INSERT ON oauth_machine_client_audit
      WHEN NEW.event = 'oauth.client.rotate_secret'
      BEGIN SELECT RAISE(ABORT, 'injected rotate audit failure'); END`);
    await assert.rejects(
      store.compareAndSwapMachineClient(1, rotated, {
        ...audit(original),
        event: "oauth.client.rotate_secret",
      }),
      /injected rotate audit failure/,
    );
    assert.deepEqual(await store.find(original.clientId), original);
    db.exec("DROP TRIGGER reject_rotate_audit");
    assert.equal(
      await store.compareAndSwapMachineClient(1, rotated, {
        ...audit(original),
        event: "oauth.client.rotate_secret",
      }),
      true,
    );

    const disabled: VersionedMachineClientRegistration = {
      ...rotated,
      status: "disabled",
      version: 3,
      secrets: [],
      disabledAtEpoch: now + 2,
    };
    db.exec(`CREATE TRIGGER reject_disable_audit
      BEFORE INSERT ON oauth_machine_client_audit
      WHEN NEW.event = 'oauth.client.disable'
      BEGIN SELECT RAISE(ABORT, 'injected disable audit failure'); END`);
    await assert.rejects(
      store.compareAndSwapMachineClient(2, disabled, {
        ...audit(original),
        event: "oauth.client.disable",
      }),
      /injected disable audit failure/,
    );
    assert.deepEqual(await store.find(original.clientId), rotated);
  } finally {
    db.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codec rejects unknown application types with the closed row shape", () => {
  const row = {
    client_id: "mcpdc_unknown",
    application_type: "service",
    redirect_uris_json: "[]",
    issued_at_epoch: 1_800_000_000,
    name: null,
    allowed_scopes_json: null,
    secrets_json: null,
    status: null,
    version: null,
    disabled_at_epoch: null,
    last_used_at_epoch: 1_800_000_000,
    updated_at_epoch: 1_800_000_000,
  };
  assert.throws(() => decodeClientRow(row, POLICY), /applicationType/);
});
