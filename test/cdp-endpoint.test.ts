import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCdpEndpoint } from "../src/config.ts";

test("CDP endpoint accepts only the frozen browser origins", () => {
  const allowed = [
    "http://localhost:9222",
    "http://127.0.0.1:9222",
    "http://[::1]:9222",
    "http://captatum-browser.captatum.svc.cluster.local:9222",
  ];
  for (const origin of allowed) {
    assert.equal(parseCdpEndpoint(` ${origin}/ `), origin);
  }
  assert.equal(parseCdpEndpoint(" \n "), undefined);
});

test("CDP endpoint rejects every non-allowlisted URL component", () => {
  const rejected = [
    "not-a-url",
    "https://localhost:9222",
    "http://localhost",
    "http://localhost:9223",
    "http://user:pass@localhost:9222",
    "http://localhost:9222/json/version",
    "http://localhost:9222/?query=1",
    "http://localhost:9222/#fragment",
    "http://other-service.captatum.svc.cluster.local:9222",
    "http://captatum-browser.other.svc.cluster.local:9222",
    "http://captatum-browser.captatum.svc.cluster.local:9223",
  ];
  for (const endpoint of rejected) {
    assert.throws(
      () => parseCdpEndpoint(endpoint),
      /CAPTATUM_BROWSER_CDP_ENDPOINT/,
      endpoint,
    );
  }
});
