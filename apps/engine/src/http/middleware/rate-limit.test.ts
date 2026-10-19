import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { AppEnv } from "../openapi.ts";
import { rateLimitMiddleware } from "./rate-limit.ts";

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
