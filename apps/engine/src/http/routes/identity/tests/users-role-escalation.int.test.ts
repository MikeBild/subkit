// Regression guard for C1: PATCH /v1/identity/users/{id} must enforce
// policy.adminOnly regardless of what permissions the route middleware
// passes through. Without this handler-level floor, any principal holding
// identity:write could PATCH their own (or another user's) role to admin.
//
// Two defence layers are tested together:
//   1. requirePermission("identity:write") middleware — members are denied
//      identity:* by the built-in member role (memberPermissionFilter in
//      rbac/seed.ts). This is the FIRST wall and denies at the middleware layer.
//   2. enforce(principal, policy.adminOnly(principal), …) in the PATCH handler —
//      defence-in-depth: catches any principal that bypassed the permission gate
//      but is not an admin (e.g. a principal granted identity:write via a custom role).
//
// These tests FAIL if either guard is removed because the member PATCH calls
// would return 200 instead of 403, and the role in the DB would change.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";

let ctx: HttpTestServer;
let memberId = "";
let memberKey = "";
let targetMemberId = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("users-role-esc");

  // Seed a member user with an API key — the attacker principal.
  const [member] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "member-esc@test.local", role: "member" })
    .returning();
  if (!member) throw new Error("seed member failed");
  memberId = member.id;
  const issued = await issueApiKey(
    { tenant_id: ctx.tenantId, owner_kind: "user", owner_id: member.id, actor_id: null },
    ctx.db,
  );
  memberKey = issued.plaintext;

  // A second member that the attacker might try to target.
  const [target] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "member-target@test.local", role: "member" })
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

    // Without the adminOnly floor the handler would return 200.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");

    // The role must be unchanged — escalation did not happen.
    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, memberId));
    expect(refreshed?.role).toBe("member");
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
    expect(refreshed?.role).toBe("member");
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

    // DB reflects the new role.
    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, targetMemberId));
    expect(refreshed?.role).toBe("admin");

    // Audit row: USER_ROLE_CHANGED must be present with the correct tenant.
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
