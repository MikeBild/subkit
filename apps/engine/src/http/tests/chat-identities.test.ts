// HTTP integration tests for /v1/chat/identities — the admin route
// that links a chat-platform user to a subkit user. Covers PR #206
// review C-2 (unlink emits the right audit action) and W-2 (link
// rejects a body.user_id that belongs to another tenant).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, chatIdentities, tenants, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let otherUserId: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-id");

  // Seed a user in a different tenant. The link route accepts a
  // body.user_id without auto-joining to the principal's tenant; this
  // user lets us test that the new tenant check (W-2) actually fires.
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-chat-id-other`, display_name: "Other Tenant" })
    .returning();
  if (!t2) throw new Error("seed second tenant");
  const [u2] = await ctx.db
    .insert(users)
    .values({ tenant_id: t2.id, email: "other-id@chat.test", role: "admin" })
    .returning();
  if (!u2) throw new Error("seed second user");
  otherUserId = u2.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(async () => {
  await ctx.db.delete(chatIdentities);
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_identity.linked"));
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_identity.unlinked"));
});

function authedHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/chat/identities", () => {
  test("W-2: rejects a body.user_id that belongs to another tenant with 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_CROSS",
        platform_user_id: "U_INTRUDER",
        user_id: otherUserId,
      }),
    });
    expect(res.status).toBe(404);

    // No chat_identities row was created.
    const rows = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_INTRUDER"));
    expect(rows).toHaveLength(0);

    // No CHAT_IDENTITY_LINKED audit was written.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.linked"));
    expect(audits).toHaveLength(0);
  });

  test("happy path: link a chat user to a same-tenant subkit user", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_OK",
        platform_user_id: "U_OK",
        user_id: ctx.userId,
      }),
    });
    expect(res.status).toBe(201);

    const rows = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_OK"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(ctx.userId);
  });
});

describe("DELETE /v1/chat/identities/{id}", () => {
  test("C-2: emits a chat_identity.unlinked audit row (not 'linked')", async () => {
    // Seed an identity so we have something to unlink.
    const [seeded] = await ctx.db
      .insert(chatIdentities)
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        platform: "slack",
        workspace_id: "T_UNLINK",
        platform_user_id: "U_BYE",
      })
      .returning();
    if (!seeded) throw new Error("seed identity");

    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities/${seeded.id}`, {
      method: "DELETE",
      headers: authedHeaders(),
    });
    expect(res.status).toBe(200);

    // The audit log must distinguish unlink from link — SIEM and the
    // admin audit view both pivot on `action`.
    const unlinkAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.unlinked"));
    expect(unlinkAudits).toHaveLength(1);

    const linkedAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.linked"));
    expect(linkedAudits).toHaveLength(0);
  });
});
