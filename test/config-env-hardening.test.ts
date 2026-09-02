// Fail-closed operator env selectors (src/env-parsing.ts). The 2026-09-01 Level-3
// re-walk executed two fail-open shapes against v0.20.2: a ConfigMap trailing
// newline ("true\n") silently disabled the in-process Chromium OS sandbox (the
// threat model's release-blocker condition), and 1e9 / 0x10 sailed through
// Number()-based integer parsing on knobs with no ceiling (global fetch
// concurrency, per-host inflight). These tests pin the strict contract: unset →
// default, whitespace trimmed, anything else throws, ceilings enforced.
// Spec: docs/threat-model.md §"Operator env selectors", docs/contracts.md §"Operator env selectors".

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const saved: Record<string, string | undefined> = {};
const NAMES = [
  "CAPTATUM_BROWSER_INPROCESS_SANDBOX",
  "CAPTATUM_GLOBAL_FETCH_CONCURRENCY",
  "CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT",
  "CAPTATUM_MAX_CONCURRENT_RENDERS",
  "CAPTATUM_BULK_ENABLED",
  "CF_ACCESS_ENABLED",
  "CAPTATUM_BULK_MAX_CONCURRENCY",
] as const;

beforeEach(() => { for (const n of NAMES) saved[n] = process.env[n]; });
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

async function freshConfig() {
  // config.ts evaluates env at call time; a fresh import is not required, but the
  // selectors read process.env on every call, so direct calls are sufficient.
  return (await import("../src/config.ts")).config;
}

test("sandbox selector: trailing newline keeps the sandbox ON (was: silently OFF)", async () => {
  const config = await freshConfig();
  process.env.CAPTATUM_BROWSER_INPROCESS_SANDBOX = "true\n";
  assert.equal(config.render.chromiumSandbox(), true);
  process.env.CAPTATUM_BROWSER_INPROCESS_SANDBOX = "  true  ";
  assert.equal(config.render.chromiumSandbox(), true);
});

test("sandbox selector: case variants and garbage are boot failures, not silent OFF", async () => {
  const config = await freshConfig();
  for (const v of ["TRUE", "True", "1", "yes", "false\nx"]) {
    process.env.CAPTATUM_BROWSER_INPROCESS_SANDBOX = v;
    assert.throws(() => config.render.chromiumSandbox(), /CAPTATUM_BROWSER_INPROCESS_SANDBOX/, v);
  }
});

test("sandbox selector: explicit false and unset keep working", async () => {
  const config = await freshConfig();
  delete process.env.CAPTATUM_BROWSER_INPROCESS_SANDBOX;
  assert.equal(config.render.chromiumSandbox(), true);
  process.env.CAPTATUM_BROWSER_INPROCESS_SANDBOX = "false";
  assert.equal(config.render.chromiumSandbox(), false);
});

test("integer selectors reject widening shapes an operator did not type", async () => {
  const config = await freshConfig();
  for (const v of ["1e9", "0x10", "3.5", "-5", "0", "1,000", "abc", "٤٢"]) {
    process.env.CAPTATUM_GLOBAL_FETCH_CONCURRENCY = v;
    assert.throws(
      () => config.bulk.globalFetchConcurrency(),
      /CAPTATUM_GLOBAL_FETCH_CONCURRENCY/,
      `expected throw for ${JSON.stringify(v)}`,
    );
  }
});

test("integer selectors: unset/whitespace → default; decimal + leading zeros + trim accepted", async () => {
  const config = await freshConfig();
  delete process.env.CAPTATUM_GLOBAL_FETCH_CONCURRENCY;
  assert.equal(config.bulk.globalFetchConcurrency(), 24);
  process.env.CAPTATUM_GLOBAL_FETCH_CONCURRENCY = " 48 ";
  assert.equal(config.bulk.globalFetchConcurrency(), 48);
  process.env.CAPTATUM_GLOBAL_FETCH_CONCURRENCY = "024";
  assert.equal(config.bulk.globalFetchConcurrency(), 24);
});

test("integer selectors enforce ceilings (no ConfigMap widening past the cap)", async () => {
  const config = await freshConfig();
  process.env.CAPTATUM_GLOBAL_FETCH_CONCURRENCY = "129";
  assert.throws(() => config.bulk.globalFetchConcurrency(), /outside the allowed range/);
  process.env.CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT = "33";
  assert.throws(() => config.bulk.maxPerHostInflight(), /outside the allowed range/);
  process.env.CAPTATUM_MAX_CONCURRENT_RENDERS = "17";
  assert.throws(() => config.render.maxConcurrentRenders(), /outside the allowed range/);
  process.env.CAPTATUM_BULK_MAX_PER_HOST_INFLIGHT = "32";
  assert.equal(config.bulk.maxPerHostInflight(), 32);
});

test("remaining operator booleans are strict too (bulk enabled, CF Access gate)", async () => {
  const config = await freshConfig();
  process.env.CAPTATUM_BULK_ENABLED = "true\n";
  assert.equal(config.bulk.enabled(), true);
  process.env.CAPTATUM_BULK_ENABLED = "1";
  assert.throws(() => config.bulk.enabled(), /CAPTATUM_BULK_ENABLED/);
  process.env.CF_ACCESS_ENABLED = "TRUE";
  assert.throws(() => config.cloudflareAccess.enabled(), /CF_ACCESS_ENABLED/);
  delete process.env.CF_ACCESS_ENABLED;
  assert.equal(config.cloudflareAccess.enabled(), false);
});

test("bulk maxConcurrency env ceiling equals the domain lowering-only clamp (no silent 5-8)", async () => {
  const config = await freshConfig();
  process.env.CAPTATUM_BULK_MAX_CONCURRENCY = "5";
  assert.throws(() => config.bulk.maxConcurrency(), /outside the allowed range/);
  process.env.CAPTATUM_BULK_MAX_CONCURRENCY = "4";
  assert.equal(config.bulk.maxConcurrency(), 4);
});

test("bulk selectors fail closed at boot even when bulk is DISABLED (codex round 2)", async () => {
  const config = await freshConfig();
  process.env.CAPTATUM_BULK_ENABLED = "false";
  process.env.CAPTATUM_BULK_QUOTA_WINDOW_SECONDS = "garbage";
  const { createHostedBulk } = await import("../src/server-runtime.ts");
  const clock = { nowMs: () => 0 };
  assert.throws(
    () => createHostedBulk({} as never, clock),
    /CAPTATUM_BULK_QUOTA_WINDOW_SECONDS/,
    "malformed sibling knobs must boot-fail even with bulk off",
  );
  process.env.CAPTATUM_BULK_QUOTA_WINDOW_SECONDS = "120";
  assert.equal(createHostedBulk({} as never, clock), undefined, "disabled bulk stays undefined with valid knobs");
});
