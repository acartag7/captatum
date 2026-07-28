import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { runMachineClientCli } from "../src/machine-client.ts";
import {
  writeAndFlush,
  type CliWritable,
  type EventedCliWritable,
} from "../src/machine-client-stream.ts";

const SAFE_TMP = realpathSync(tmpdir());

test("stdout close before callback settles and disables the exact committed client", async (t) => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-cli-close-"));
  const file = join(dir, "auth.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const closing = new Writable({
    write(_chunk, _encoding, _callback) {
      setImmediate(() => closing.destroy());
    },
  });
  const exitCode = await Promise.race([
    runMachineClientCli(["provision", "close-before-callback", "fetch:read"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: closing as unknown as CliWritable,
      stderr: { completion: "synchronous", write() { return true; } },
    }),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
  ]);
  assert.equal(exitCode, 1, "the command must reject, not hang");

  let listed = "";
  assert.equal(
    await runMachineClientCli(["list"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: { completion: "synchronous", write(chunk) { listed += chunk; return true; } },
      stderr: { completion: "synchronous", write() { return true; } },
    }),
    0,
  );
  const clients = JSON.parse(listed) as Array<{ status: string; version: number }>;
  assert.deepEqual(
    clients.map(({ status, version }) => ({ status, version })),
    [{ status: "disabled", version: 2 }],
  );
});

test("writeAndFlush settles once across callback/error/close orderings", async () => {
  const successful = new ScriptedWritable((stream, callback) => {
    callback?.();
    stream.emit("close");
    stream.emitSafeError(new Error("late error"));
  });
  await writeAndFlush(successful, "ok");
  assert.equal(successful.listenerCount("error"), 0);
  assert.equal(successful.listenerCount("close"), 0);

  const errorFirst = new ScriptedWritable((stream, callback) => {
    stream.emitSafeError(new Error("early error"));
    callback?.();
    stream.emit("close");
  });
  await assert.rejects(writeAndFlush(errorFirst, "bad"), /early error/);

  const closeFirst = new ScriptedWritable((stream, callback) => {
    stream.emit("close");
    callback?.();
  });
  await assert.rejects(writeAndFlush(closeFirst, "bad"), /closed/);

  const callbackError = new ScriptedWritable((_stream, callback) => {
    callback?.(new Error("callback error"));
  });
  await assert.rejects(writeAndFlush(callbackError, "bad"), /callback error/);

  const callbackOnly: CliWritable = {
    completion: "callback",
    write(_chunk, callback = () => {}) {
      setImmediate(() => callback?.(new Error("callback-only error")));
      return true;
    },
  };
  await assert.rejects(
    writeAndFlush(callbackOnly, "bad"),
    /callback-only error/,
  );

  const restCallback: CliWritable = {
    completion: "callback",
    write(_chunk, ...callbacks) {
      setImmediate(() => callbacks[0]?.(new Error("rest callback error")));
      return true;
    },
  };
  await assert.rejects(
    writeAndFlush(restCallback, "bad"),
    /rest callback error/,
  );

  const backpressured: CliWritable = {
    completion: "callback",
    write(_chunk, callback) {
      setImmediate(() => callback());
      return false;
    },
  };
  await writeAndFlush(backpressured, "delivered");
});

test("default-parameter callback failure compensates a committed credential", async (t) => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-cli-callback-"));
  const file = join(dir, "auth.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failed: CliWritable = {
    completion: "callback",
    write(_chunk, callback = () => {}) {
      setImmediate(() => callback(new Error("late callback failure")));
      return true;
    },
  };
  assert.equal(
    await runMachineClientCli(["provision", "callback-failure", "fetch:read"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: failed,
      stderr: { completion: "synchronous", write() { return true; } },
    }),
    1,
  );
  let listed = "";
  assert.equal(
    await runMachineClientCli(["list"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: {
        completion: "synchronous",
        write(chunk) { listed += chunk; return true; },
      },
      stderr: { completion: "synchronous", write() { return true; } },
    }),
    0,
  );
  assert.equal(
    (JSON.parse(listed) as Array<{ status: string }>)[0]?.status,
    "disabled",
  );
});

test("lost stderr diagnostics do not invalidate a delivered credential and durable audit", async (t) => {
  const dir = mkdtempSync(join(SAFE_TMP, "captatum-cli-stderr-close-"));
  const file = join(dir, "auth.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let stdout = "";
  const closingStderr = new Writable({
    write(_chunk, _encoding, _callback) {
      setImmediate(() => closingStderr.destroy());
    },
  });
  assert.equal(
    await runMachineClientCli(["provision", "stderr-close", "fetch:read"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: { completion: "synchronous", write(chunk) { stdout += chunk; return true; } },
      stderr: closingStderr as unknown as CliWritable,
    }),
    0,
  );
  const credential = JSON.parse(stdout) as {
    clientId: string;
    clientSecret: string;
  };
  assert.match(credential.clientSecret, /^mcs_/);

  let listed = "";
  assert.equal(
    await runMachineClientCli(["list"], {
      env: { TIDB_HOST: "", CAPTATUM_SQLITE_PATH: file },
      stdout: { completion: "synchronous", write(chunk) { listed += chunk; return true; } },
      stderr: { completion: "synchronous", write() { return true; } },
    }),
    0,
  );
  assert.deepEqual(
    (JSON.parse(listed) as Array<{ clientId: string; status: string }>)
      .map(({ clientId, status }) => ({ clientId, status })),
    [{ clientId: credential.clientId, status: "active" }],
  );
});

class ScriptedWritable extends EventEmitter implements EventedCliWritable {
  private readonly script: (
    stream: ScriptedWritable,
    callback?: (error?: Error | null) => void,
  ) => void;

  constructor(script: ScriptedWritable["script"]) {
    super();
    this.script = script;
  }

  write(
    _chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.script(this, callback);
    return true;
  }

  emitSafeError(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}
