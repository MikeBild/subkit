import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  chatIdentities,
  chatWorkspaces,
  systemAccounts,
  users,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let otherUserId: string;
let memberKey = "";
let systemAccountKey = "";

const apiKeyHex = createDeterministicHexFactory(0xcbb1101);
function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-id");
  await ctx.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(ctx.db, "admin") })
    .where(eq(systemAccounts.id, ctx.systemAccountId));
  systemAccountKey = `wf_live_${apiKeyHex(24).slice(0, 32)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    system_account_id: ctx.systemAccountId,
    prefix: systemAccountKey.slice(0, 12),
    token_sha256: sha256Hex(systemAccountKey),
    scopes: ["*"],
  });

  const t2 = await seedTenant(ctx.db, { slug: `t-chat-id-other`, display_name: "Other Tenant" });
  const [u2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: t2.id,
      email: "other-id@chat.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!u2) throw new Error("seed second user");
  otherUserId = u2.id;

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-chatid@chat.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member user");
  const plain = `wf_live_${apiKeyHex(24).slice(0, 32)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: plain.slice(0, 12),
    token_sha256: sha256Hex(plain),
    scopes: ["*"],
  });
  memberKey = plain;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(async () => {
  await ctx.db.delete(chatIdentities);
  await ctx.db.delete(chatWorkspaces);
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_identity.linked"));
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_identity.unlinked"));
});

function authedHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  };
}

function memberHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${memberKey}`,
    "content-type": "application/json",
  };
}

function systemAccountHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${systemAccountKey}`,
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

    const rows = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_INTRUDER"));
    expect(rows).toHaveLength(0);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.linked"));
    expect(audits).toHaveLength(0);
  });

  test("happy path: link a chat user to a same-tenant subkit user", async () => {
    await ctx.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenantId,
      platform: "slack",
      workspace_id: "T_OK",
      bot_ciphertext: Buffer.from([0]),
      bot_iv: Buffer.from([0]),
      bot_auth_tag: Buffer.from([0]),
    });

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
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "chat_identity.linked"),
          eq(auditLog.resource_id, ctx.userId),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: ctx.userId });
  });

  test("a system-account key links and unlinks with its typed actor pair", async () => {
    await ctx.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenantId,
      platform: "slack",
      workspace_id: "T_SYSTEM_ACTOR",
      bot_ciphertext: Buffer.from([0]),
      bot_iv: Buffer.from([0]),
      bot_auth_tag: Buffer.from([0]),
    });

    const linked = await fetch(`${ctx.baseUrl}/v1/chat/identities`, {
      method: "POST",
      headers: systemAccountHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_SYSTEM_ACTOR",
        platform_user_id: "U_SYSTEM_ACTOR",
        user_id: ctx.userId,
      }),
    });
    expect(linked.status).toBe(201);
    const linkedBody = (await linked.json()) as { id: string };
    const [linkAudit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "chat_identity.linked"),
          eq(auditLog.resource_id, ctx.userId),
        ),
      );
    expect(linkAudit).toEqual({
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
    });

    const unlinked = await fetch(`${ctx.baseUrl}/v1/chat/identities/${linkedBody.id}`, {
      method: "DELETE",
      headers: systemAccountHeaders(),
    });
    expect(unlinked.status).toBe(200);
    const [unlinkAudit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "chat_identity.unlinked"),
          eq(auditLog.resource_id, ctx.userId),
        ),
      );
    expect(unlinkAudit).toEqual({
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
    });
  });

  test("rejects a body.workspace_id that isn't installed in this tenant with 404", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_FOREIGN",
        platform_user_id: "U_VICTIM",
        user_id: ctx.userId,
      }),
    });
    expect(res.status).toBe(404);

    const rows = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_VICTIM"));
    expect(rows).toHaveLength(0);
  });
});

describe("RBAC negative — non-admin lacks chat_identity:write", () => {
  test("member POST /v1/chat/identities is denied with 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_RBAC",
        platform_user_id: "U_RBAC",
        user_id: ctx.userId,
      }),
    });
    expect(res.status).toBe(403);
    const rows = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_RBAC"));
    expect(rows).toHaveLength(0);
  });

  test("member DELETE /v1/chat/identities/{id} is denied with 403", async () => {
    const [seed] = await ctx.db
      .insert(chatIdentities)
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        platform: "slack",
        workspace_id: "T_RBAC_DEL",
        platform_user_id: "U_RBAC_DEL",
      })
      .returning();
    if (!seed) throw new Error("seed for rbac delete test");
    const res = await fetch(`${ctx.baseUrl}/v1/chat/identities/${seed.id}`, {
      method: "DELETE",
      headers: memberHeaders(),
    });
    expect(res.status).toBe(403);
    const after = await ctx.db.select().from(chatIdentities).where(eq(chatIdentities.id, seed.id));
    expect(after).toHaveLength(1);
  });
});

describe("DELETE /v1/chat/identities/{id}", () => {
  test("C-2: emits a chat_identity.unlinked audit row (not 'linked')", async () => {
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

    const unlinkAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.unlinked"));
    expect(unlinkAudits).toHaveLength(1);
    expect(unlinkAudits[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });

    const linkedAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.linked"));
    expect(linkedAudits).toHaveLength(0);
  });
});
