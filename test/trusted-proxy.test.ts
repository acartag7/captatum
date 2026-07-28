import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrustedProxyCidrs } from "../src/domain/trusted-proxy.ts";

test("trusted proxy parser accepts only a bounded unique IP/CIDR allowlist", () => {
  assert.deepEqual(
    parseTrustedProxyCidrs("127.0.0.1/32, ::1/128, 192.0.2.10"),
    ["127.0.0.1/32", "::1/128", "192.0.2.10"],
  );
  for (const raw of [
    "", " ", "loopback", "*", "127.0.0.1,", "127.0.0.1/33",
    "::1/129", "127.0.0.1/-1", "127.0.0.1/1e1",
    "0.0.0.0/0", "10.0.0.0/8", "::/0", "2001:db8::/63",
    "127.0.0.1/32/1", "127.0.0.1,127.0.0.1",
  ]) {
    assert.throws(
      () => parseTrustedProxyCidrs(raw),
      /CAPTATUM_TRUSTED_PROXY_CIDRS/,
      raw,
    );
  }
});

test("trusted proxy parser caps configured peers", () => {
  const entries = Array.from(
    { length: 33 },
    (_, index) => `192.0.2.${index + 1}`,
  );
  assert.throws(
    () => parseTrustedProxyCidrs(entries.join(",")),
    /CAPTATUM_TRUSTED_PROXY_CIDRS/,
  );
});
