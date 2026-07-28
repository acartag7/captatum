import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("gateway image prepares private writable /data before USER node", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const mkdirAt = dockerfile.indexOf("mkdir -p /data");
  const chownAt = dockerfile.indexOf("chown node:node /data");
  const chmodAt = dockerfile.indexOf("chmod 0700 /data");
  const userAt = dockerfile.indexOf("\nUSER node");
  assert.ok(mkdirAt >= 0 && chownAt > mkdirAt && chmodAt > chownAt);
  assert.ok(userAt > chmodAt, "fresh named-volume metadata is prepared before privilege drop");
});

test("container deployment uses the offline direct-node machine-client entrypoint", () => {
  const deploy = readFileSync(join(ROOT, "deploy", "README.md"), "utf8");
  assert.match(deploy, /exec gateway \\\n  node --no-warnings src\/machine-client\.ts provision/);
  assert.match(deploy, /exec gateway \\\n  node --no-warnings src\/machine-client\.ts rotate/);
  assert.doesNotMatch(deploy, /exec gateway[^\n]*\n\s+pnpm/);
  assert.ok(readFileSync(join(ROOT, "src", "machine-client.ts"), "utf8").length > 0);
});

test("generic container deploys pin the tunnel peer and omit unsafe browser sharing", () => {
  for (const path of [
    ["deploy", "docker-compose.yml"],
    ["deploy", "ec2-user-data.sh"],
  ]) {
    const deploy = readFileSync(join(ROOT, ...path), "utf8");
    assert.match(
      deploy,
      /CAPTATUM_TRUSTED_PROXY_CIDRS: "172\.29\.255\.249\/32"/,
    );
    assert.match(deploy, /subnet: "172\.29\.255\.248\/29"/);
    assert.match(deploy, /gateway: "172\.29\.255\.249"/);
    assert.doesNotMatch(deploy, /network_mode: "service:gateway"/);
    assert.doesNotMatch(deploy, /CAPTATUM_BROWSER_CDP_ENDPOINT/);
    assert.doesNotMatch(deploy, /^\s+browser:\s*$/m);
    assert.doesNotMatch(deploy, /^\s+image:.*captatum-browser/m);
    assert.doesNotMatch(
      deploy,
      /CAPTATUM_TRUSTED_PROXY_CIDRS: "127\.0\.0\.1/,
    );
  }
});
