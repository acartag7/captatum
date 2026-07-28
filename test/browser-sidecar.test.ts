import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/browser-sidecar.sh", import.meta.url);

test("browser launcher binds only loopback", () => {
  for (const [address, expected] of [
    [undefined, "--remote-debugging-address=127.0.0.1"],
    ["127.0.0.1", "--remote-debugging-address=127.0.0.1"],
  ] as const) {
    const result = runLauncher({
      ...(address ? { CAPTATUM_BROWSER_CDP_BIND_ADDRESS: address } : {}),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(expected.replaceAll(".", "\\.")));
    assert.match(result.stdout, /--remote-debugging-port=9222/);
  }
});

test("browser launcher rejects malformed bind and port before Chromium", () => {
  for (const env of [
    { CAPTATUM_BROWSER_CDP_BIND_ADDRESS: "0.0.0.0.example" },
    { CAPTATUM_BROWSER_CDP_BIND_ADDRESS: "0.0.0.0" },
    { CAPTATUM_BROWSER_CDP_BIND_ADDRESS: "::" },
    { CAPTATUM_BROWSER_CDP_BIND_ADDRESS: "" },
    { CAPTATUM_BROWSER_CDP_PORT: "0" },
    { CAPTATUM_BROWSER_CDP_PORT: "65536" },
    { CAPTATUM_BROWSER_CDP_PORT: "9222x" },
    { CAPTATUM_BROWSER_CDP_PORT: "" },
  ]) {
    const result = runLauncher(env);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /browser-sidecar: invalid CDP/);
  }
});

function runLauncher(env: Record<string, string | undefined>) {
  const directory = mkdtempSync(join(tmpdir(), "captatum-browser-launcher-"));
  const fake = join(directory, "chromium");
  writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  chmodSync(fake, 0o755);
  try {
    return spawnSync("bash", [script.pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        ...env,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
