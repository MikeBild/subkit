// HTTP integration tests for /v1/chat/workspaces.
//
// Covers:
//   * GET is tenant-scoped (no cross-tenant leak in the list).
//   * DELETE on a workspace that belongs to another tenant returns 404.
//   * The installer-link-conflict path returns 409 and rolls back
//     the whole install — no chat_workspaces row, no audit row.
//   * Idempotent reinstall of the same operator emits an install_noop
//     audit, not a misleading kind:install.
//
// Per-tenant isolation is asserted by inserting rows directly into a
// second tenant (the seeded test server only creates one tenant), then
// driving the route as the first tenant's admin and asserting the
// second tenant's rows are invisible.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  apiKeys,
  auditLog,
  chatIdentities,
  chatWorkspaces,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let otherTenantId: string;
let otherUserId: string;
let memberKey = "";
const SIGNING_SECRET = "test-slack-signing-secret-xyz";

const apiKeyHex = createDeterministicHexFactory(0xcbbaaa1);
function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

beforeAll(async () => {
  ctx = await createHttpTestServer("chat-ws");
  // The install route refuses if the engine has no Slack signing secret.
  await setConfigKey("platform.slack.signing_secret", SIGNING_SECRET);

  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-chat-ws-other`, display_name: "Other Tenant" })
    .returning();
  if (!t2) throw new Error("seed second tenant");
  otherTenantId = t2.id;
  const [u2] = await ctx.db
    .insert(users)
    .values({ tenant_id: otherTenantId, email: "other@chat.test", role: "admin" })
    .returning();
  if (!u2) throw new Error("seed second user");
  otherUserId = u2.id;

  // Provision a non-admin (`member`) user in the SAME tenant for RBAC
  // negative tests. requirePermission("chat_workspace:write") rejects
  // them with 403; admins (the default ctx.apiKey) pass.
  const [member] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "member-chatws@chat.test", role: "member" })
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
  // Wipe any chat state left by a previous test in the same file so
  // assertions on row count and audit history are independent.
  await ctx.db.delete(chatWorkspaces);
  await ctx.db.delete(chatIdentities);
  // Also clear chat-related audit rows so per-test assertions on
  // audit-row counts are bounded to *this* test's actions.
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

    const ids = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_OPERATOR"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.user_id).toBe(ctx.userId);
  });

  test("W-3: installer link conflict rolls back the entire install", async () => {
    // Seed an identity that binds U_COLLISION → the OTHER tenant's user
    // (a wholly different subkit principal). The install attempts to
    // bind the same Slack id to ctx.userId; the transaction must roll
    // back. No chat_workspaces row, no audit row, 409 to the operator.
    await ctx.db.insert(chatIdentities).values({
      tenant_id: ctx.tenantId,
      // Bind under the current tenant but to a different user (the
      // other tenant's user_id is reused as a stand-in for "some other
      // subkit user"). The DB FK only constrains existence, not tenant.
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

    // Rollback: no chat_workspaces row exists for T_COLLIDE.
    const ws = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_COLLIDE"));
    expect(ws).toHaveLength(0);

    // The pre-seeded identity is untouched (it predates the install).
    const ids = await ctx.db
      .select()
      .from(chatIdentities)
      .where(eq(chatIdentities.platform_user_id, "U_COLLISION"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.user_id).toBe(otherUserId);

    // No CHAT_WORKSPACE_INSTALLED audit was emitted (the transaction
    // rolled back before any audit insert ran).
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
    // Remove the workspace but keep the identity so the second install
    // hits the "platform_user_id already linked to THIS user" branch.
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
    // Install in this tenant.
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

    // Seed a workspace row directly for the other tenant.
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
    // Seed a row in the other tenant. The new global unique index on
    // (platform, workspace_id) makes a second install in *this* tenant
    // impossible; the install route catches the collision first and
    // emits a clear 409 + denied audit before the DB throws.
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

    // No row created in our tenant for that workspace_id.
    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_CLAIMED"));
    expect(after).toHaveLength(1);
    expect(after[0]?.tenant_id).toBe(otherTenantId);

    // Denied audit recorded with the workspace_already_claimed reason;
    // metadata does NOT include the foreign tenant_id (would leak
    // across the isolation boundary).
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
    // No row was written.
    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, "T_RBAC"));
    expect(after).toHaveLength(0);
  });

  test("member DELETE /v1/chat/workspaces/{id} is denied with 403", async () => {
    // Seed a workspace as admin to give member something to try deleting.
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
    // Row is still there.
    const after = await ctx.db.select().from(chatWorkspaces).where(eq(chatWorkspaces.id, seed.id));
    expect(after).toHaveLength(1);
  });
});

describe("DELETE /v1/chat/workspaces/{id}", () => {
  test("returns 404 for a workspace that belongs to another tenant", async () => {
    // Seed the foreign-tenant workspace and capture its id.
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

    // Confirm the foreign row is still there.
    const after = await ctx.db
      .select()
      .from(chatWorkspaces)
      .where(and(eq(chatWorkspaces.id, foreign!.id), eq(chatWorkspaces.tenant_id, otherTenantId)));
    expect(after).toHaveLength(1);
  });
});
