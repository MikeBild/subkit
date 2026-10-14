import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  apiKeys,
  auditLog,
  chatIdentities,
  chatWorkspaces,
  systemAccounts,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let otherTenantId: string;
let otherUserId: string;
let memberUserId: string;
let memberKey = "";
let systemAccountKey = "";
const SIGNING_SECRET = "test-slack-signing-secret-xyz";

const apiKeyHex = createDeterministicHexFactory(0xcbbaaa1);
function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-ws");
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
  await setConfigKey("platform.slack.signing_secret", SIGNING_SECRET);

  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-chat-ws-other`, display_name: "Other Tenant" })
    .returning();
  if (!t2) throw new Error("seed second tenant");
  otherTenantId = t2.id;
  const [u2] = await ctx.db
    .insert(users)
    .values({
      tenant_id: otherTenantId,
      email: "other@chat.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!u2) throw new Error("seed second user");
  otherUserId = u2.id;

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-chatws@chat.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member user");
  memberUserId = member.id;
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
  await ctx.db.delete(chatWorkspaces);
  await ctx.db.delete(chatIdentities);
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_workspace.installed"));
  await ctx.db.delete(auditLog).where(eq(auditLog.action, "chat_workspace.removed"));
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

describe("POST /v1/chat/workspaces", () => {
  test("happy path: install creates row + installer identity link", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_HAPPY",
        bot_token: "xoxb-test-1",
        installer_platform_user_id: "U_OPERATOR",
      }),
    });
    expect(res.status).toBe(201);

    const ws = await ctx.db.select().from(chatWorkspaces);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.tenant_id).toBe(ctx.tenantId);
    const workspaceId = ws[0]?.id;
    if (!workspaceId) throw new Error("installed workspace row missing id");

    const ids = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_OPERATOR"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.user_id).toBe(ctx.userId);
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "chat_workspace.installed"),
          eq(auditLog.resource_id, workspaceId),
        ),
      );
    expect(audit).toEqual({ actor_type: "user", actor_id: ctx.userId });
  });

  test("W-3: installer link conflict rolls back the entire install", async () => {
    await ctx.db.insert(chatIdentities).values({
      tenant_id: ctx.tenantId,
      user_id: otherUserId,
      platform: "slack",
      workspace_id: "T_COLLIDE",
      platform_user_id: "U_COLLISION",
    });

    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_COLLIDE",
        bot_token: "xoxb-test-2",
        installer_platform_user_id: "U_COLLISION",
      }),
    });
    expect(res.status).toBe(409);

    const ws = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_COLLIDE"));
    expect(ws).toHaveLength(0);

    const ids = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_COLLISION"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.user_id).toBe(otherUserId);

    const installedAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_workspace.installed"));
    expect(installedAudits).toHaveLength(0);
  });

  test("idempotent reinstall (same operator, same Slack id) emits install_noop audit", async () => {
    const body = JSON.stringify({
      platform: "slack",
      workspace_id: "T_NOOP",
      bot_token: "xoxb-test-3",
      installer_platform_user_id: "U_OPERATOR",
    });
    const first = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body,
    });
    expect(first.status).toBe(201);
    const workspaces = await ctx.db.select().from(chatWorkspaces);
    expect(workspaces).toHaveLength(1);
    await ctx.db.delete(chatWorkspaces).where(eq(chatWorkspaces.id, workspaces[0]!.id));

    const second = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body,
    });
    expect(second.status).toBe(201);

    const linkAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_identity.linked"));
    const installNoops = linkAudits.filter(
      (r) => (r.metadata as { kind?: string } | null)?.kind === "install_noop",
    );
    expect(installNoops.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/chat/workspaces", () => {
  test("does not list workspaces from another tenant", async () => {
    const installRes = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_MINE",
        bot_token: "xoxb-test-mine",
        installer_platform_user_id: "U_ME",
      }),
    });
    expect(installRes.status).toBe(201);

    await ctx.db.insert(chatWorkspaces).values({
      tenant_id: otherTenantId,
      platform: "slack",
      workspace_id: "T_OTHER",
      bot_ciphertext: Buffer.from([0]),
      bot_iv: Buffer.from([0]),
      bot_auth_tag: Buffer.from([0]),
    });

    const listRes = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      headers: authedHeaders(),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ workspace_id: string }> };
    expect(list.items.find((w) => w.workspace_id === "T_MINE")).toBeDefined();
    expect(list.items.find((w) => w.workspace_id === "T_OTHER")).toBeUndefined();
  });
});

describe("Global uniqueness — a Slack team_id is one tenant's only", () => {
  test("foreign-tenant install of the same workspace_id returns 409 and writes denied audit", async () => {
    await ctx.db.insert(chatWorkspaces).values({
      tenant_id: otherTenantId,
      platform: "slack",
      workspace_id: "T_CLAIMED",
      bot_ciphertext: Buffer.from([0]),
      bot_iv: Buffer.from([0]),
      bot_auth_tag: Buffer.from([0]),
    });

    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_CLAIMED",
        bot_token: "xoxb-claim-attempt",
        installer_platform_user_id: "U_CLAIMANT",
      }),
    });
    expect(res.status).toBe(409);

    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_CLAIMED"));
    expect(after).toHaveLength(1);
    expect(after[0]?.tenant_id).toBe(otherTenantId);

    const denied = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat_workspace.installed"));
    const claim = denied.find((r) => r.result === "denied");
    expect(claim).toBeTruthy();
    expect(claim?.reason).toBe("workspace_already_claimed");
    const meta = claim?.metadata as Record<string, unknown> | null;
    expect(meta?.workspace_id).toBe("T_CLAIMED");
    expect(meta?.tenant_id).toBeUndefined();
    expect(meta?.existing_tenant_id).toBeUndefined();
  });
});

describe("RBAC negative — non-admin lacks chat_workspace:write", () => {
  test("member POST /v1/chat/workspaces is denied with 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({
        platform: "slack",
        workspace_id: "T_RBAC",
        bot_token: "xoxb-test-rbac",
        installer_platform_user_id: "U_RBAC",
      }),
    });
    expect(res.status).toBe(403);
    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_RBAC"));
    expect(after).toHaveLength(0);
  });

  test("member DELETE /v1/chat/workspaces/{id} is denied with 403", async () => {
    const [seed] = await ctx.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenantId,
        platform: "slack",
        workspace_id: "T_RBAC_DEL",
        bot_ciphertext: Buffer.from([0]),
        bot_iv: Buffer.from([0]),
        bot_auth_tag: Buffer.from([0]),
      })
      .returning();
    if (!seed) throw new Error("seed for rbac delete test");
    const res = await fetch(`${ctx.baseUrl}/v1/chat/workspaces/${seed.id}`, {
      method: "DELETE",
      headers: memberHeaders(),
    });
    expect(res.status).toBe(403);
    const [deniedAudit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "policy.denied"),
          eq(auditLog.actor_id, memberUserId),
          eq(auditLog.reason, "permission_denied:chat_workspace:write"),
        ),
      );
    expect(deniedAudit).toEqual({ actor_type: "user", actor_id: memberUserId });
    const after = await ctx.db.select().from(chatWorkspaces).where(eq(chatWorkspaces.id, seed.id));
    expect(after).toHaveLength(1);
  });
});

describe("DELETE /v1/chat/workspaces/{id}", () => {
  test("a system-account key removes a workspace and retains its actor pair", async () => {
    const [seeded] = await ctx.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenantId,
        platform: "slack",
        workspace_id: "T_SYSTEM_REMOVE",
        bot_ciphertext: Buffer.from([0]),
        bot_iv: Buffer.from([0]),
        bot_auth_tag: Buffer.from([0]),
      })
      .returning();
    if (!seeded) throw new Error("seed system-account workspace removal");

    const response = await fetch(`${ctx.baseUrl}/v1/chat/workspaces/${seeded.id}`, {
      method: "DELETE",
      headers: systemAccountHeaders(),
    });
    expect(response.status).toBe(200);
    const [audit] = await ctx.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "chat_workspace.removed"),
          eq(auditLog.resource_id, seeded.id),
        ),
      );
    expect(audit).toEqual({
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
    });
    const remaining = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(and(eq(chatWorkspaces.id, seeded.id), eq(chatWorkspaces.tenant_id, ctx.tenantId)));
    expect(remaining).toHaveLength(0);
  });

  test("returns 404 for a workspace that belongs to another tenant", async () => {
    const [foreign] = await ctx.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: otherTenantId,
        platform: "slack",
        workspace_id: "T_FOREIGN",
        bot_ciphertext: Buffer.from([0]),
        bot_iv: Buffer.from([0]),
        bot_auth_tag: Buffer.from([0]),
      })
      .returning();
    expect(foreign).toBeTruthy();

    const delRes = await fetch(`${ctx.baseUrl}/v1/chat/workspaces/${foreign!.id}`, {
      method: "DELETE",
      headers: authedHeaders(),
    });
    expect(delRes.status).toBe(404);

    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(and(eq(chatWorkspaces.id, foreign!.id), eq(chatWorkspaces.tenant_id, otherTenantId)));
    expect(after).toHaveLength(1);
  });
});
