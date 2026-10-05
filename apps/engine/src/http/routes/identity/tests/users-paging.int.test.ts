import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { events, users } from "../../../../db/schema/index.ts";
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
  await ctx.cleanup();
});

const headers = () => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

async function page(query: string) {
  const res = await fetch(`${ctx.baseUrl}/v1/identity/users?${query}`, { headers: headers() });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: { email: string }[]; total: number };
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
      body: JSON.stringify({ email: "paging-new@test.local", role: "member" }),
    });
    expect(res.status).toBe(201);
    const announced = await ctx.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "identity.changed")));
    expect(announced.length).toBe(1);
  });
});
