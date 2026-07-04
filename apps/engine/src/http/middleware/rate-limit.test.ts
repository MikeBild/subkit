// Rate-limiter client-IP resolution (arch-rl).
//
// The limiter keys buckets on the client IP. Reading the LEFTMOST
// X-Forwarded-For entry let any client forge it (send a random XFF value
// per request) and evade the limit entirely. The IP must come from the
// proxy-appended RIGHT-hand entries instead.

import { describe, expect, test } from "bun:test";
import { resolveClientIp } from "./rate-limit.ts";

describe("resolveClientIp", () => {
  test("with one trusted proxy, uses the rightmost (proxy-appended) entry", () => {
    // Client forged "1.1.1.1"; our Caddy appended the real peer last.
    expect(resolveClientIp("1.1.1.1, 203.0.113.9", undefined, 1)).toBe("203.0.113.9");
  });

  test("a single-entry XFF (direct client behind one proxy) is used as-is", () => {
    expect(resolveClientIp("203.0.113.9", undefined, 1)).toBe("203.0.113.9");
  });

  test("forged leftmost entries cannot change the resolved IP", () => {
    const forged = "9.9.9.9, 8.8.8.8, 203.0.113.9";
    // Same real client → same bucket key regardless of forged prefix.
    expect(resolveClientIp(forged, undefined, 1)).toBe("203.0.113.9");
    expect(resolveClientIp("203.0.113.9", undefined, 1)).toBe("203.0.113.9");
  });

  test("two trusted proxies reads the second-from-right entry", () => {
    expect(resolveClientIp("forged, 203.0.113.9, 10.0.0.2", undefined, 2)).toBe("203.0.113.9");
  });

  test("falls back to x-real-ip then 'unknown' when XFF is absent", () => {
    expect(resolveClientIp(undefined, "203.0.113.5", 1)).toBe("203.0.113.5");
    expect(resolveClientIp(undefined, undefined, 1)).toBe("unknown");
  });
});
