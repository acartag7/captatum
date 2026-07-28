import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClockPort } from "../src/application/ports/clock.ts";
import { InMemoryAuthRateLimit } from "../src/infrastructure/in-memory-auth-rate-limit.ts";

class MutableClock implements ClockPort {
  private ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
  advance(ms: number): void { this.ms += ms; }
}

test("auth limiter rejects the eleventh registration and resets after ten minutes", async () => {
  const clock = new MutableClock(1_000);
  const limiter = new InMemoryAuthRateLimit(clock);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(await limiter.check("register:192.0.2.1"), true);
  }
  assert.equal(await limiter.check("register:192.0.2.1"), false);
  assert.equal(
    await limiter.check("token:192.0.2.1"),
    true,
    "the registration bucket cannot take token exchange down",
  );
  clock.advance(10 * 60 * 1000);
  assert.equal(await limiter.check("register:192.0.2.1"), true);
});

test("auth limiter bounds source-key storage and fails closed at capacity", async () => {
  const clock = new MutableClock(1_000);
  const limiter = new InMemoryAuthRateLimit(clock);
  for (let source = 0; source < 4096; source++) {
    assert.equal(await limiter.check(`register:192.0.2.${source}`), true);
  }
  assert.equal(await limiter.check("register:overflow"), false);
  assert.equal(
    await limiter.check("register:192.0.2.0"),
    true,
    "an existing bucket remains usable when unknown-key admission is closed",
  );
});

test("auth limiter denies malformed keys, unknown surfaces, and invalid clocks", async () => {
  const validClock = new MutableClock(1_000);
  const limiter = new InMemoryAuthRateLimit(validClock);
  assert.equal(await limiter.check("authorize:192.0.2.1"), false);
  assert.equal(await limiter.check(""), false);
  assert.equal(
    await new InMemoryAuthRateLimit({ nowMs: () => Number.NaN }).check("register:source"),
    false,
  );
});
