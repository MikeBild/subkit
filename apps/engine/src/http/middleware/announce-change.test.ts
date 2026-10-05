import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, gt } from "drizzle-orm";
import { events, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import type { AppEnv } from "../openapi.ts";
import {
  announcesChange,
  CHANGE_ANNOUNCEMENTS,
  registerChangeAnnouncements,
} from "./announce-change.ts";

let ctx: TestDb;
let tenantId = "";

function app() {
  const hono = new OpenAPIHono<AppEnv>();
  hono.use("*", async (c, next) => {
    c.set("db", ctx.db as never);
    c.set("principal", adminPrincipal(tenantId));
    await next();
  });
  registerChangeAnnouncements(hono);
  hono.post("/v1/identity/api-keys", (c) => c.json({ ok: true }, 201));
  hono.delete("/v1/identity/api-keys/:id", (c) => c.json({ ok: false }, 404));
  hono.get("/v1/identity/api-keys", (c) => c.json({ items: [] }));
  hono.patch("/v1/settings/:path", (c) => c.json({ ok: true }));
  hono.post("/v1/rbac/can", (c) => c.json({ allow: true }));
  hono.post("/v1/rbac/groups", (c) => c.json({ ok: true }, 201));
  return hono;
}

async function changesSince(id: number): Promise<string[]> {
  const rows = await ctx.db
    .select({ type: events.type })
    .from(events)
    .where(
      and(
        eq(events.tenant_id, tenantId),
        eq(events.channel, "resource.lifecycle"),
        gt(events.id, id),
      ),
    )
    .orderBy(asc(events.id));
  return rows.map((row) => row.type);
}

async function lastEventId(): Promise<number> {
  const rows = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.tenant_id, tenantId))
    .orderBy(asc(events.id));
  return rows.at(-1)?.id ?? 0;
}

beforeAll(async () => {
  ctx = await createTestDb("announce_change");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "announce-change", display_name: "Announce" })
    .returning();
  tenantId = tenant!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("list change announcements", () => {
  test("a successful write announces its list; reads and failed writes stay silent", async () => {
    const before = await lastEventId();
    const hono = app();
    expect((await hono.request("/v1/identity/api-keys", { method: "POST" })).status).toBe(201);
    expect((await hono.request("/v1/identity/api-keys")).status).toBe(200);
    expect((await hono.request("/v1/identity/api-keys/x", { method: "DELETE" })).status).toBe(404);
    expect((await hono.request("/v1/settings/llm.model", { method: "PATCH" })).status).toBe(200);
    expect((await hono.request("/v1/rbac/can", { method: "POST" })).status).toBe(200);
    expect((await hono.request("/v1/rbac/groups", { method: "POST" })).status).toBe(201);
    expect(await changesSince(before)).toEqual([
      "api_key.changed",
      "settings.changed",
      "rbac.changed",
    ]);
  });

  test("the permission check is a read even though it is a POST", () => {
    const rbac = CHANGE_ANNOUNCEMENTS.find((entry) => entry.type === "rbac.changed");
    expect(rbac).toBeDefined();
    if (!rbac) return;
    expect(announcesChange(rbac, "POST", "/v1/rbac/can", 200)).toBe(false);
    expect(announcesChange(rbac, "POST", "/v1/rbac/roles", 201)).toBe(true);
    expect(announcesChange(rbac, "GET", "/v1/rbac/roles", 200)).toBe(false);
    expect(announcesChange(rbac, "DELETE", "/v1/rbac/roles/x", 403)).toBe(false);
  });
});
