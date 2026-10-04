// The last administrator cannot leave the role.
//
// Admin-only routes check the role NAME, so moving the only admin to member,
// to a custom role (even one holding every permission), or deactivating them
// leaves a workspace nobody can manage people or roles in. Each path refuses
// with 409 `last_admin` and changes nothing; with a second admin present the
// same change goes through.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { roles, users } from "../../../../db/schema/index.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;
let customRoleId = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("last-admin");
  const [role] = await ctx.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "Alles-außer-Name", description: null })
    .returning();
  if (!role) throw new Error("seed custom role failed");
  customRoleId = role.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = () => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

async function roleOf(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  return row;
}

describe("the only administrator", () => {
  test("cannot be moved to member", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${ctx.userId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("last_admin");
    expect((await roleOf(ctx.userId))?.role_id).toBe(await builtinRoleId(ctx.db, "admin"));
  });

  test("cannot be given a custom role through RBAC", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/rbac/users/${ctx.userId}/role`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ role_id: customRoleId }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("last_admin");
    expect((await roleOf(ctx.userId))?.role_id).toBe(await builtinRoleId(ctx.db, "admin"));
  });

  test("cannot be deactivated", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${ctx.userId}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(409);
    expect((await roleOf(ctx.userId))?.deleted_at).toBeNull();
  });
});

describe("with a second administrator", () => {
  test("the first one may leave the role", async () => {
    await ctx.db.insert(users).values({
      tenant_id: ctx.tenantId,
      email: "second-admin@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    });
    const res = await fetch(`${ctx.baseUrl}/v1/rbac/users/${ctx.userId}/role`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ role_id: customRoleId }),
    });
    expect(res.status).toBe(200);
    expect((await roleOf(ctx.userId))?.role_id).toBe(customRoleId);
  });
});
