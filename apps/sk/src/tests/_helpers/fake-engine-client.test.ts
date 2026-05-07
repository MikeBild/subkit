import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_PROFILE,
  createFakeEngineClient,
  fakeClientCallCounts,
} from "./fake-engine-client.ts";

describe("createFakeEngineClient", () => {
  test("skBootstrap returns the canned full UX permission set by default", async () => {
    const c = createFakeEngineClient();
    const r = await c.skBootstrap();
    expect(r.permissions.length).toBeGreaterThan(15);
    expect(r.permissions).toContain("audit:read");
    expect(r.whoami.email).toBe("fake@test.local");
    expect(fakeClientCallCounts(c).bootstrap).toBe(1);
  });

  test("custom permissions override the default", async () => {
    const c = createFakeEngineClient({ bootstrap: { permissions: ["conversation:read"] } });
    const r = await c.skBootstrap();
    expect(r.permissions).toEqual(["conversation:read"]);
  });

  test("errorOnBootstrap rejects the call", async () => {
    const c = createFakeEngineClient({ errorOnBootstrap: new Error("HTTP 404") });
    await expect(c.skBootstrap()).rejects.toThrow("HTTP 404");
  });

  test("rbacAllow customizes per-permission decisions", async () => {
    const c = createFakeEngineClient({
      rbacAllow: (p) => p === "conversation:read",
    });
    expect((await c.rbacCan({ principal_id: "x", permission: "conversation:read" })).allow).toBe(
      true,
    );
    expect((await c.rbacCan({ principal_id: "x", permission: "audit:read" })).allow).toBe(false);
  });

  test("ANONYMOUS_PROFILE is shaped like ResolvedProfile", () => {
    expect(ANONYMOUS_PROFILE.name).toBe("default");
    expect(ANONYMOUS_PROFILE.engine_url).toContain("http");
    expect(ANONYMOUS_PROFILE.api_key.length).toBeGreaterThan(0);
  });
});
