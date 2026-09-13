import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("auth");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("auth on /v1/identity/tenants", () => {
  test("no bearer -> 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  test("bad bearer -> 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`, {
      headers: { authorization: "Bearer wf_live_definitelyNotARealKey0123456" },
    });
    expect(res.status).toBe(401);
  });

  test("malformed bearer (wrong prefix) -> 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`, {
      headers: { authorization: "Bearer not_a_subkit_key" },
    });
    expect(res.status).toBe(401);
  });

  test("good bearer -> 200 + returns own tenant", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.id).toBe(ctx.tenantId);
  });

  test("query token also authenticates", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/v1/identity/tenants?token=${encodeURIComponent(ctx.apiKey)}`,
    );
    expect(res.status).toBe(200);
  });
});
