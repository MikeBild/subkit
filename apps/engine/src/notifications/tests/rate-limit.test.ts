import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __peekBucket, __resetRateLimiter, tryAcquire } from "../rate-limit.ts";

beforeEach(() => {
  __resetRateLimiter();
});
afterEach(() => {
  __resetRateLimiter();
});

describe("notifications: rate-limit", () => {
  test("allows up to capacity per minute and rejects the rest", () => {
    const key = { tenant_id: "t1", workspace_id: "W1", channel_id: "C1" };
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) {
      const r = tryAcquire(key, 60, 1, t0);
      expect(r.ok).toBe(true);
    }
    const r = tryAcquire(key, 60, 1, t0);
    expect(r.ok).toBe(false);
    expect(typeof r.retryAfterMs).toBe("number");
    expect((r.retryAfterMs ?? 0) > 0).toBe(true);
  });

  test("refills proportionally after time passes", () => {
    const key = { tenant_id: "t2", workspace_id: "W1", channel_id: "C2" };
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) {
      expect(tryAcquire(key, 60, 1, t0).ok).toBe(true);
    }
    expect(tryAcquire(key, 60, 1, t0).ok).toBe(false);

    const t1 = t0 + 1_000;
    expect(tryAcquire(key, 60, 1, t1).ok).toBe(true);
    expect(tryAcquire(key, 60, 1, t1).ok).toBe(false);
  });

  test("keys are independent per channel", () => {
    const a = { tenant_id: "t3", workspace_id: "W1", channel_id: "C_A" };
    const b = { tenant_id: "t3", workspace_id: "W1", channel_id: "C_B" };
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) expect(tryAcquire(a, 60, 1, t0).ok).toBe(true);
    expect(tryAcquire(a, 60, 1, t0).ok).toBe(false);
    expect(tryAcquire(b, 60, 1, t0).ok).toBe(true);
    expect(__peekBucket(b)?.tokens).toBe(59);
  });
});
