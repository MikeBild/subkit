import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { encryptSecret } from "../../crypto/index.ts";
import { chatIdentities, chatWorkspaces, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { chatWorkspaceAad } from "../api.ts";
import { listPendingSpacesForPrincipal } from "../pending-spaces.ts";

let ctx: ConversationTestCtx;
let tenantBId: string;
let userBId: string;

const CALLER_PID = "users/g-caller-1";
const OTHER_PID = "users/g-other-1";

async function seedDeny(md: {
  platform: string;
  workspace_id_native: string;
  sender_platform_user_id: string | null;
  space_display_name?: string | null;
}) {
  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CHAT_MESSAGE_DENIED,
      resource_type: "chat_message",
      resource_id: null,
      result: "denied",
      reason: "workspace_not_installed",
      metadata: {
        platform: md.platform,
        workspace_id_native: md.workspace_id_native,
        event_key: null,
        kind: "mention",
        sender_platform_user_id: md.sender_platform_user_id,
        space_display_name: md.space_display_name ?? null,
      },
    },
    ctx.testDb.db,
  );
}

async function installedWorkspace(workspace_id: string, tenant_id: string) {
  const placeholder = encryptSecret("__seed__");
  const [row] = await ctx.testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id,
      platform: "google_chat",
      workspace_id,
      bot_ciphertext: placeholder.ciphertext,
      bot_iv: placeholder.iv,
      bot_auth_tag: placeholder.auth_tag,
    })
    .returning();
  if (!row) throw new Error("seed workspace failed");
  const bound = encryptSecret("__seed__", chatWorkspaceAad(row.tenant_id, row.id));
  await ctx.testDb.db
    .update(chatWorkspaces)
    .set({ bot_ciphertext: bound.ciphertext, bot_iv: bound.iv, bot_auth_tag: bound.auth_tag })
    .where(eq(chatWorkspaces.id, row.id));
  return row;
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("pending-spaces");

  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "google_chat",
    workspace_id: "spaces/DM_A",
    platform_user_id: CALLER_PID,
  });

  const tenantB = await seedTenant(ctx.testDb.db, {
    slug: "t-pending-b",
    display_name: "Pending B",
  });
  tenantBId = tenantB.id;
  const [userB] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: tenantBId,
      email: "pending-b@test.local",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning();
  if (!userB) throw new Error("seed user B failed");
  userBId = userB.id;
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: tenantBId,
    user_id: userBId,
    platform: "google_chat",
    workspace_id: "spaces/DM_B",
    platform_user_id: OTHER_PID,
  });

  await seedDeny({
    platform: "google_chat",
    workspace_id_native: "spaces/OK",
    sender_platform_user_id: CALLER_PID,
    space_display_name: "Space OK",
  });
  await seedDeny({
    platform: "google_chat",
    workspace_id_native: "spaces/NULLSENDER",
    sender_platform_user_id: null,
  });
  await seedDeny({
    platform: "slack",
    workspace_id_native: "T-SLACK",
    sender_platform_user_id: CALLER_PID,
  });
  await seedDeny({
    platform: "google_chat",
    workspace_id_native: "spaces/OTHERTENANT",
    sender_platform_user_id: OTHER_PID,
  });
  await seedDeny({
    platform: "google_chat",
    workspace_id_native: "spaces/INSTALLED",
    sender_platform_user_id: CALLER_PID,
  });
  await installedWorkspace("spaces/INSTALLED", tenantBId);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("chat: pending-space discovery attribution", () => {
  test("returns only the caller's owned, uninstalled, global-id candidate", async () => {
    const items = await listPendingSpacesForPrincipal(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
    });
    const ids = items.map((i) => i.workspace_id);
    expect(ids).toContain("spaces/OK");
    expect(ids).not.toContain("spaces/NULLSENDER");
    expect(ids).not.toContain("T-SLACK");
    expect(ids).not.toContain("spaces/OTHERTENANT");
    expect(ids).not.toContain("spaces/INSTALLED");
    const ok = items.find((i) => i.workspace_id === "spaces/OK");
    expect(ok).toEqual({
      platform: "google_chat",
      workspace_id: "spaces/OK",
      display_name: "Space OK",
      installer_platform_user_id: CALLER_PID,
    });
  });

  test("cross-tenant: caller B sees only their own id's pending space", async () => {
    const items = await listPendingSpacesForPrincipal(ctx.testDb.db, {
      tenant_id: tenantBId,
      user_id: userBId,
    });
    const ids = items.map((i) => i.workspace_id);
    expect(ids).toContain("spaces/OTHERTENANT");
    expect(ids).not.toContain("spaces/OK");
  });

  test("a principal with no chat_identity gets nothing", async () => {
    const [lonely] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "lonely@test.local",
        role_id: await builtinRoleId(ctx.testDb.db, "member"),
      })
      .returning();
    if (!lonely) throw new Error("seed lonely user failed");
    const items = await listPendingSpacesForPrincipal(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      user_id: lonely.id,
    });
    expect(items).toEqual([]);
  });

  test("a non-global-id platform filter fails closed", async () => {
    const items = await listPendingSpacesForPrincipal(
      ctx.testDb.db,
      { tenant_id: ctx.tenant_id, user_id: ctx.user_id },
      { platform: "slack" },
    );
    expect(items).toEqual([]);
  });
});
