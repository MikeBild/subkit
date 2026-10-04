import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;
let memberId = "";
let memberKey = "";
let targetMemberId = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("users-role-esc");

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-esc@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  memberId = member.id;
  const issued = await issueApiKey(
    { tenant_id: ctx.tenantId, owner_kind: "user", owner_id: member.id, actor_id: null },
    ctx.db,
  );
  memberKey = issued.plaintext;

  const [target] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-target@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!target) throw new Error("seed target member failed");
  targetMemberId = target.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function adminHeaders() {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}
function memberHeaders() {
  return { authorization: `Bearer ${memberKey}`, "content-type": "application/json" };
}

describe("C1 — member self-escalation via PATCH is blocked", () => {
  test("member PATCH own role to admin returns 403 and leaves DB role unchanged", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${memberId}`, {
      method: "PATCH",
      headers: memberHeaders(),
      body: JSON.stringify({ role: "admin" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");

    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, memberId));
    expect(refreshed?.role_id).toBe(await builtinRoleId(ctx.db, "member"));
  });

  test("member PATCH another member's role to admin returns 403 and leaves DB role unchanged", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${targetMemberId}`, {
      method: "PATCH",
      headers: memberHeaders(),
      body: JSON.stringify({ role: "admin" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");

    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, targetMemberId));
    expect(refreshed?.role_id).toBe(await builtinRoleId(ctx.db, "member"));
  });
});

describe("C1 — admin can update another user's role (happy-path guard)", () => {
  test("admin PATCH target-member role to admin → 200 + role changed + USER_ROLE_CHANGED audit row", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${targetMemberId}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ role: "admin" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string };
    expect(body.role).toBe("admin");

    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, targetMemberId));
    expect(refreshed?.role_id).toBe(await builtinRoleId(ctx.db, "admin"));

    const auditRows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "user.role_changed"), eq(auditLog.resource_id, targetMemberId)),
      );
    expect(auditRows.length).toBeGreaterThan(0);
    expect(auditRows[0]?.tenant_id).toBe(ctx.tenantId);
    expect(auditRows[0]?.result).toBe("success");
  });
});
