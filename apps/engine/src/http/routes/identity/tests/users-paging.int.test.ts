import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, events, tenants, users } from "../../../../db/schema/index.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("users-paging");
  const member = await builtinRoleId(ctx.db, "member");
  await ctx.db.insert(users).values(
    ["a", "b", "c"].map((name) => ({
      tenant_id: ctx.tenantId,
      email: `paging-${name}@test.local`,
      role_id: member,
    })),
  );
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

const headers = () => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

async function page(query: string) {
  const res = await fetch(`${ctx.baseUrl}/v1/identity/users?${query}`, { headers: headers() });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: { id: string; email: string; display_name: string | null }[];
    total: number;
  };
}

describe("people list", () => {
  test("pages by offset and counts every person, so the list can load to the end", async () => {
    const first = await page("limit=2");
    const second = await page("limit=2&offset=2");
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    const emails = [...first.items, ...second.items].map((item) => item.email);
    expect(new Set(emails).size).toBe(4);
  });

  test("adding a person announces the people list change", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        email: "paging-new@test.local",
        display_name: "Mika Müller",
        role: "member",
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      display_name: string | null;
      updated_at: string;
    };
    expect(created.display_name).toBe("Mika Müller");
    const announced = await ctx.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "identity.changed")));
    expect(announced.length).toBe(1);
    const detail = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      headers: headers(),
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { display_name: string | null }).display_name).toBe(
      "Mika Müller",
    );
    const noOp = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ display_name: "Mika Müller" }),
    });
    expect(((await noOp.json()) as { updated_at: string }).updated_at).toBe(created.updated_at);
    const update = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ display_name: "  Mika Bild  " }),
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { display_name: string | null }).display_name).toBe(
      "Mika Bild",
    );
    const updatedList = await page("limit=200");
    expect(updatedList.items.find((item) => item.id === created.id)?.display_name).toBe(
      "Mika Bild",
    );
    const clear = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ display_name: null }),
    });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { display_name: string | null }).display_name).toBeNull();
    const clearedList = await page("limit=200");
    expect(clearedList.items.find((item) => item.id === created.id)?.display_name).toBeNull();
    const emptyPatch = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);
    const [otherTenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "paging-other-tenant", display_name: "Other tenant" })
      .returning({ id: tenants.id });
    if (!otherTenant) throw new Error("other tenant was not created");
    const member = await builtinRoleId(ctx.db, "member");
    const [foreignUser] = await ctx.db
      .insert(users)
      .values({
        tenant_id: otherTenant.id,
        email: "foreign-paging@test.local",
        role_id: member,
      })
      .returning({ id: users.id });
    if (!foreignUser) throw new Error("foreign test user was not created");
    const foreignDetail = await fetch(`${ctx.baseUrl}/v1/identity/users/${foreignUser.id}`, {
      headers: headers(),
    });
    expect(foreignDetail.status).toBe(404);
    expect(
      (await page("limit=200")).items.some((item) => item.email === "foreign-paging@test.local"),
    ).toBe(false);
    const profileAudit = await ctx.db
      .select({ actor_type: auditLog.actor_type })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, created.id),
          eq(auditLog.action, "user.profile_updated"),
        ),
      );
    expect(profileAudit).toHaveLength(2);
    expect(profileAudit.every((entry) => entry.actor_type === "user")).toBe(true);
  });
});
