import type { RateLimitPort } from "mcp-sso";
import type { ClockPort } from "../application/ports/clock.ts";

interface WindowPolicy {
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const POLICIES: Record<"register" | "authorize" | "cimd" | "token", WindowPolicy> = {
  register: { limit: 10, windowMs: 10 * 60 * 1000 },
  authorize: { limit: 120, windowMs: 60 * 1000 },
  cimd: { limit: 10, windowMs: 10 * 60 * 1000 },
  token: { limit: 120, windowMs: 60 * 1000 },
};
const MAX_KEYS = 4096;
const MAX_KEY_LENGTH = 512;

/** Single-replica auth flood control. Every internal error returns DENY. */
export class InMemoryAuthRateLimit implements RateLimitPort {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: ClockPort;

  constructor(clock: ClockPort) {
    this.clock = clock;
  }

  async check(key: string): Promise<boolean> {
    try {
      if (
        typeof key !== "string"
        || key.length < 1
        || key.length > MAX_KEY_LENGTH
      ) return false;
      const separator = key.indexOf(":");
      const prefix = key.slice(0, separator);
      const policy = Object.hasOwn(POLICIES, prefix)
        ? POLICIES[prefix as keyof typeof POLICIES]
        : undefined;
      if (!policy) return false;
      const now = this.clock.nowMs();
      if (!Number.isSafeInteger(now) || now < 0) return false;
      const current = this.buckets.get(key);
      if (current && current.resetAt > now) {
        current.count += 1;
        return current.count <= policy.limit;
      }
      this.prune(now);
      if (!current && this.buckets.size >= MAX_KEYS) return false;
      this.buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
      return true;
    } catch {
      return false;
    }
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
