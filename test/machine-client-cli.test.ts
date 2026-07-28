import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  parseMachineClientArgs,
  runMachineClientCli,
} from "../src/machine-client.ts";
import { createHostedAuthStore } from "../src/infrastructure/auth-store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAFE_TMP = realpathSync(tmpdir());
const ENTRYPOINT = join(ROOT, "src", "machine-client.ts");

function run(args: string[], sqlitePath: string) {
  return spawnSync(process.execPath, ["--no-warnings", ENTRYPOINT, ...args], {
    cwd: ROOT,
    env: { ...process.env, TIDB_HOST: "", CAPTATUM_SQLITE_PATH: sqlitePath },
    encoding: "utf8",
  });
}

test("machine-client argument parser rejects incomplete, unknown, and ambiguous commands", () => {
  assert.deepEqual(parseMachineClientArgs(["--", "provision", "name", "fetch:read"]), {
    action: "provision", name: "name", scopes: ["fetch:read"],
  }, "pnpm's forwarded separator is accepted only in the leading position");
  assert.throws(() => parseMachineClientArgs([]), /usage/);
  assert.throws(() => parseMachineClientArgs(["provision", "name"]), /usage/);
  assert.throws(() => parseMachineClientArgs(["provision", "name", "unknown:scope"]), /scope catalog/);
  assert.throws(
    () => parseMachineClientArgs(["provision", "name", "fetch:read", "fetch:read"]),
    /duplicates/,
  );
  assert.throws(() => parseMachineClientArgs(["rotate", "not-machine"]), /machine client id/);
  assert.deepEqual(parseMachineClientArgs(["rotate", "mcc_valid"]), {
    action: "rotate", clientId: "mcc_valid", graceSeconds: 300,
  });
  assert.deepEqual(parseMachineClientArgs(["rotate", "mcc_valid", "600"]), {
    action: "rotate", clientId: "mcc_valid", graceSeconds: 600,
  });
  assert.throws(() => parseMachineClientArgs(["rotate", "mcc_valid", "0"]), /\[1, 600\]/);
  assert.throws(() => parseMachineClientArgs(["rotate", "mcc_valid", "601"]), /\[1, 600\]/);
  assert.throws(() => parseMachineClientArgs(["rotate", "mcc_valid", "1e3"]), /decimal/);
  assert.throws(() => parseMachineClientArgs(["rotate", "mcc_valid", "10", "extra"]), /usage/);
  assert.deepEqual(parseMachineClientArgs(["disable", "mcc_valid"]), {
    action: "disable", clientId: "mcc_valid",
  });
  assert.deepEqual(parseMachineClientArgs(["list"]), { action: "list" });
});

test("machine-client emits the durable credential before reporting a close failure", async (t) => {
  let stdout = "";
  let stderr = "";
  let closeCalls = 0;
  let selectedConfig: unknown;
  const operatorState = mkdtempSync(join(SAFE_TMP, "captatum-cli-select-"));
  t.after(() => rmSync(operatorState, { recursive: true, force: true }));
  const operatorPath = join(operatorState, "operator-auth.sqlite");
  const clients = new Map<string, unknown>();
  const exitCode = await runMachineClientCli(["provision", "close-failure", "fetch:read"], {
    env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: operatorPath },
    stdout: { write(chunk: string) { stdout += chunk; return true; } },
    stderr: { write(chunk: string) { stderr += chunk; return true; } },
    openStores: (async (selected: unknown) => {
      selectedConfig = selected;
      return {
        store: {},
        clientStore: {
          async save(client: { clientId: string }) { clients.set(client.clientId, client); },
          async find(clientId: string) { return clients.get(clientId) ?? null; },
          async createMachineClient(client: { clientId: string }) {
            if (clients.has(client.clientId)) return false;
            clients.set(client.clientId, client);
            return true;
          },
          async compareAndSwapMachineClient(
            expectedVersion: number,
            client: { clientId: string; version: number },
          ) {
            const current = clients.get(client.clientId) as { version?: number } | undefined;
            if (current?.version !== expectedVersion) return false;
            clients.set(client.clientId, client);
            return true;
          },
          async listMachineClients() { return []; },
          async sweepStaleClients() { return 0; },
        },
        backend: "sqlite",
        async close() { closeCalls += 1; throw new Error("injected close failure"); },
      };
    }) as never,
  });
  assert.equal(exitCode, 1, "post-emission close failure is a truthful non-zero exit");
  assert.deepEqual(selectedConfig, {
    backend: "sqlite",
    stateDirectory: operatorState,
    authFilename: operatorPath,
    clientFilename: `${operatorPath}.clients`,
  }, "CLI uses the same derived path selection as server composition");
  assert.equal(closeCalls, 1, "the failed close is not retried after credential emission");
  assert.equal(stdout.trim().split("\n").length, 1);
  const credential = JSON.parse(stdout) as { clientId: string; clientSecret: string };
  assert.equal(clients.has(credential.clientId), true, "the credential was durably saved before output");
  assert.match(stderr, /credential_or_result_emitted; close_failed/);
  assert.ok(!stderr.includes(credential.clientSecret), "the close diagnostic never repeats the secret");
});

test("machine-client entrypoint separates one-time credentials from secret-free stderr", () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-machine-cli-"));
  const file = join(dir, "auth.sqlite");
  try {
    const provision = run(["provision", "nightly-fetch", "fetch:read"], file);
    assert.equal(provision.status, 0, provision.stderr);
    assert.equal(provision.signal, null);
    assert.equal(provision.stdout.trim().split("\n").length, 1, "stdout has exactly one JSON result");
    const first = JSON.parse(provision.stdout) as { clientId: string; clientSecret: string };
    assert.match(first.clientId, /^mcc_/);
    assert.match(first.clientSecret, /^mcs_/);
    assert.match(provision.stderr, /oauth\.client\.provision/);
    assert.match(provision.stderr, /machine-client store: sqlite/);
    assert.ok(!provision.stderr.includes(first.clientSecret));

    const rotate = run(["rotate", first.clientId, "10"], file);
    assert.equal(rotate.status, 0, rotate.stderr);
    assert.equal(rotate.stdout.trim().split("\n").length, 1, "rotation stdout has exactly one JSON result");
    const next = JSON.parse(rotate.stdout) as { clientSecret: string };
    assert.deepEqual(Object.keys(next).sort(), ["clientSecret", "version"]);
    assert.match(next.clientSecret, /^mcs_/);
    assert.match(rotate.stderr, /oauth\.client\.rotate_secret/);
    assert.ok(!rotate.stderr.includes(first.clientSecret));
    assert.ok(!rotate.stderr.includes(next.clientSecret));

    const db = new DatabaseSync(`${file}.clients`, { readOnly: true });
    const row = db.prepare("SELECT secrets_json FROM oauth_clients WHERE client_id = ?").get(first.clientId);
    db.close();
    const secrets = JSON.parse(String(row?.secrets_json)) as Array<{ hash: string }>;
    assert.equal(secrets.length, 2);
    for (const secret of secrets) {
      assert.ok(!provision.stderr.includes(secret.hash));
      assert.ok(!rotate.stderr.includes(secret.hash));
    }

    const disable = run(["disable", first.clientId], file);
    assert.equal(disable.status, 0, disable.stderr);
    const disabled = JSON.parse(disable.stdout) as { clientId: string; version: number };
    assert.equal(disabled.clientId, first.clientId);
    const list = run(["list"], file);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(
      (JSON.parse(list.stdout) as Array<{ status: string }>)[0]?.status,
      "disabled",
    );
    const rejectedRotate = run(["rotate", first.clientId, "10"], file);
    assert.equal(rejectedRotate.status, 1);
    assert.equal(rejectedRotate.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package exposes the operator-only machine-client script", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["machine-client"], "node --no-warnings src/machine-client.ts");
});

test("stderr EPIPE cannot suppress a committed credential or durable audit", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-machine-stderr-"));
  const file = join(dir, "auth.sqlite");
  let stdout = "";
  try {
    const exitCode = await runMachineClientCli(
      ["provision", "stderr-epipe", "fetch:read"],
      {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
        stdout: { write(chunk: string) { stdout += chunk; return true; } },
        stderr: {
          write() {
            throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
          },
        },
      },
    );
    assert.equal(exitCode, 0);
    const credential = JSON.parse(stdout) as {
      clientId: string;
      clientSecret: string;
    };
    assert.match(credential.clientSecret, /^mcs_/);
    const db = new DatabaseSync(`${file}.clients`, { readOnly: true });
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM oauth_machine_client_audit WHERE client_id = ?",
      ).get(credential.clientId) as { count: number }).count,
      1,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, stdout] of [
  [
    "EPIPE",
    { write() { throw Object.assign(new Error("broken pipe"), { code: "EPIPE" }); } },
  ],
  ["short write", { write() { return false; } }],
] as const) {
  test(`stdout ${label} disables the committed credential before returning failure`, async () => {
    const dir = mkdtempSync(join(SAFE_TMP, "captatum-machine-stdout-"));
    const file = join(dir, "auth.sqlite");
    let listed = "";
    try {
      const exitCode = await runMachineClientCli(
        ["provision", "output-failure", "fetch:read"],
        {
          env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
          stdout,
          stderr: { write() { return true; } },
        },
      );
      assert.equal(exitCode, 1);
      const listCode = await runMachineClientCli(["list"], {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
        stdout: { write(chunk: string) { listed += chunk; return true; } },
        stderr: { write() { return true; } },
      });
      assert.equal(listCode, 0);
      const clients = JSON.parse(listed) as Array<{
        clientId: string;
        status: string;
      }>;
      assert.equal(clients.length, 1);
      assert.equal(clients[0]!.status, "disabled");
      const rotate = run(["rotate", clients[0]!.clientId, "10"], file);
      assert.equal(rotate.status, 1);
      assert.equal(rotate.stdout, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("failed output compensation has a supported list then disable recovery", async () => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-machine-recovery-"));
  const file = join(dir, "auth.sqlite");
  let stderr = "";
  try {
    const exitCode = await runMachineClientCli(
      ["provision", "recovery", "fetch:read"],
      {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
        stdout: {
          write() {
            throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
          },
        },
        stderr: { write(chunk: string) { stderr += chunk; return true; } },
        openStores: async (selected, policy) => {
          const stores = await createHostedAuthStore(selected, policy);
          const db = new DatabaseSync(`${file}.clients`);
          db.exec(`CREATE TRIGGER reject_compensating_disable
            BEFORE INSERT ON oauth_machine_client_audit
            WHEN NEW.event = 'oauth.client.disable'
            BEGIN SELECT RAISE(ABORT, 'injected disable failure'); END`);
          db.close();
          return stores;
        },
      },
    );
    assert.equal(exitCode, 2);
    assert.match(stderr, /disable_failed; run_list_then_disable/);

    const db = new DatabaseSync(`${file}.clients`);
    db.exec("DROP TRIGGER reject_compensating_disable");
    db.close();

    let listOutput = "";
    assert.equal(
      await runMachineClientCli(["list"], {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
        stdout: { write(chunk: string) { listOutput += chunk; return true; } },
        stderr: { write() { return true; } },
      }),
      0,
    );
    const listed = JSON.parse(listOutput) as Array<{
      clientId: string;
      status: string;
    }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, "active");

    assert.equal(
      await runMachineClientCli(["disable", listed[0]!.clientId], {
        env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
      }),
      0,
    );
    const checked = new DatabaseSync(`${file}.clients`, { readOnly: true });
    assert.equal(
      checked.prepare(
        "SELECT status FROM oauth_clients WHERE client_id = ?",
      ).get(listed[0]!.clientId)?.status,
      "disabled",
    );
    checked.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
