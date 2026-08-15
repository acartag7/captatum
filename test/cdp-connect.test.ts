import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCdpConnectUrl } from "../src/infrastructure/render/cdp-connect.ts";

test("CDP connect URL swaps the Service hostname for its resolved address", async () => {
  const url = await resolveCdpConnectUrl(
    "http://captatum-browser.captatum.svc.cluster.local:9222",
    async (hostname) => {
      assert.equal(hostname, "captatum-browser.captatum.svc.cluster.local");
      return "10.43.38.129";
    },
  );
  assert.equal(url, "http://10.43.38.129:9222");
});

test("CDP connect URL is unchanged for IP-literal and localhost endpoints", async () => {
  const resolver = async (hostname: string): Promise<string> => {
    throw new Error(`resolver must not run for ${hostname}`);
  };
  assert.equal(
    await resolveCdpConnectUrl("http://10.43.38.129:9222", resolver),
    "http://10.43.38.129:9222",
  );
  assert.equal(
    await resolveCdpConnectUrl("http://localhost:9222", resolver),
    "http://localhost:9222",
  );
});

test("CDP connect URL brackets a resolved IPv6 address", async () => {
  const url = await resolveCdpConnectUrl(
    "http://browser.svc.cluster.local:9222",
    async () => "fd00::1a",
  );
  assert.equal(url, "http://[fd00::1a]:9222");
});

test("a resolver failure propagates (fail closed — no silent fallback to the DNS name)", async () => {
  await assert.rejects(
    resolveCdpConnectUrl("http://captatum-browser.captatum.svc.cluster.local:9222", async () => {
      throw new Error("NXDOMAIN");
    }),
    /NXDOMAIN/,
  );
});
