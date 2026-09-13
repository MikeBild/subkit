import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AuthProviderRegistry } from "../../auth/registry.ts";
import { authMiddleware } from "./auth.ts";

describe("authMiddleware dedicated credential routes", () => {
  test("leaves only the exact CLI exchange bearer for its route to consume", async () => {
    let resolutions = 0;
    const registry = {
      async resolve() {
        resolutions += 1;
        return null;
      },
    } as unknown as AuthProviderRegistry;
    const app = new Hono();
    app.use("*", authMiddleware(registry));
    app.all("*", (c) => c.text("ok"));

    expect(
      (await app.request("http://example.test/v1/identity/cli-session", { method: "POST" })).status,
    ).toBe(200);
    expect(resolutions).toBe(0);

    await app.request("http://example.test/v1/identity/cli-session");
    await app.request("http://example.test/v1/identity/cli-session/other", { method: "POST" });
    expect(resolutions).toBe(2);
  });
});
