// Pending-space discovery (`chat/pending-spaces.ts`) — the fail-closed
// attribution matrix. The SYSTEM deny pool is tenant-blind, so the ONLY
// thing keeping one caller from reading another's pending spaces is the
// caller-owned-identity join. Each test below pins one leak the join
// must close:
//
//   - a matching, owned, installed-nowhere candidate IS returned;
//   - a `null` sender is never matched (NULL-safe);
//   - a slack/teams (workspace-scoped) deny row is never surfaced even
//     if a sender id somehow got written (defense in depth);
//   - a deny row for ANOTHER tenant's user id is never attributed to us;
//   - an already-installed space is excluded (no dead pick);
//   - a caller with no chat_identity gets nothing;
//   - a non-global-id platform filter fails closed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import { chatIdentities, chatWorkspaces, tenants, users } from "../../db/schema/index.ts";
import { chatWorkspaceAad } from "../api.ts";
import { listPendingSpacesForPrincipal } from "../pending-spaces.ts";

let ctx: ConversationTestCtx;
let tenantBId: string;
let userBId: string;

const CALLER_PID = "users/g-caller-1";
const OTHER_PID = "users/g-other-1";

// Seed a SYSTEM-tenant workspace_not_installed deny row through the real
// audit writer (generates id + ts, no determinism-lint hazard).
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

  // Caller (tenant A) owns CALLER_PID via an existing (DM) identity.
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "google_chat",
    workspace_id: "spaces/DM_A",
    platform_user_id: CALLER_PID,
  });

  // Tenant B + user B owning OTHER_PID.
  const [tenantB] = await ctx.testDb.db
    .insert(tenants)
    .values({ slug: "t-pending-b", display_name: "Pending B" })
    .returning();
  if (!tenantB) throw new Error("seed tenant B failed");
  tenantBId = tenantB.id;
  const [userB] = await ctx.testDb.db
    .insert(users)
    .values({ tenant_id: tenantBId, email: "pending-b@test.local", role: "member" })
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

  // Deny rows exercising each branch.
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
    sender_platform_user_id: CALLER_PID, // hypothetical regressed write
  });
  await seedDeny({
    platform: "google_chat",
    workspace_id_native: "spaces/OTHERTENANT",
    sender_platform_user_id: OTHER_PID,
  });
  // Installed-elsewhere: a deny for the caller, but the space is already
  // registered (in tenant B) → the global unique index would 409 → hide.
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
    // Every leak the join must close:
    expect(ids).not.toContain("spaces/NULLSENDER"); // NULL-safe
    expect(ids).not.toContain("T-SLACK"); // non-global-id platform
    expect(ids).not.toContain("spaces/OTHERTENANT"); // another user's id
    expect(ids).not.toContain("spaces/INSTALLED"); // already installed
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
    expect(ids).not.toContain("spaces/OK"); // caller A's id — never attributed to B
  });

  test("a principal with no chat_identity gets nothing", async () => {
    const [lonely] = await ctx.testDb.db
      .insert(users)
      .values({ tenant_id: ctx.tenant_id, email: "lonely@test.local", role: "member" })
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
