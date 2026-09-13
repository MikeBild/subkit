// Rate-limiter client-IP resolution (arch-rl).
//
// The limiter keys buckets on the client IP. Reading the LEFTMOST
// X-Forwarded-For entry let any client forge it (send a random XFF value
// per request) and evade the limit entirely. The IP must come from the
// proxy-appended RIGHT-hand entries instead.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { AppEnv } from "../openapi.ts";
import { rateLimitMiddleware, resolveClientIp } from "./rate-limit.ts";

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

describe("rateLimitMiddleware", () => {
  const principal: ResolvedPrincipal = {
    provider: "api_key",
    kind: "system_account",
    id: "system-account-1",
    tenant_id: "tenant-1",
    roles: ["admin"],
  };

  test("does not consume the anonymous IP budget for authenticated principals", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", principal);
      await next();
    });
    app.use("*", rateLimitMiddleware({ max: 1, windowMs: 60_000 }));
    app.get("/", (c) => c.text("ok"));

    for (let request = 0; request < 3; request++) {
      const response = await app.request("http://localhost/", {
        headers: { "x-real-ip": "203.0.113.5" },
      });
      expect(response.status).toBe(200);
    }
  });

  test("continues to limit anonymous requests by IP", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", rateLimitMiddleware({ max: 1, windowMs: 60_000 }));
    app.get("/", (c) => c.text("ok"));

    const first = await app.request("http://localhost/", {
      headers: { "x-real-ip": "203.0.113.5" },
    });
    const second = await app.request("http://localhost/", {
      headers: { "x-real-ip": "203.0.113.5" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
  });
});
