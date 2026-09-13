// DM auto-registration (`chat/dm-autoregister.ts`):
//
//   - Fail-closed identity match: an unlinked sender is denied
//     (`dm_sender_not_linked`); a sender linked in more than one
//     (tenant, user) pair is denied (`dm_sender_ambiguous`); neither
//     writes a single row.
//   - The capability gate: only DM events on platforms whose user ids
//     are tenant-global (`PLATFORM_HAS_GLOBAL_USER_IDS`) qualify —
//     non-DM events and Slack events deny as `not_dm_autoregistrable`.
//   - Exactly one match provisions `chat_workspaces` (bound sentinel
//     cipher under the row's AAD, `default_channel` = the DM channel)
//     plus the DM-space `chat_identities` row, and audits both writes
//     with `metadata.kind = "dm_autoregister"`.
//   - Idempotency: a second call for the same DM space reuses the
//     existing row (onConflictDoNothing path) — one row, same id.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { AuditAction } from "../../audit/types.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { decryptSecret } from "../../crypto/aes-gcm.ts";
import { auditLog, chatIdentities, chatWorkspaces, tenants, users } from "../../db/schema/index.ts";
import { chatWorkspaceAad } from "../api.ts";
import { ensureDmAutoRegistration } from "../dm-autoregister.ts";
import type { ChatEvent } from "../types.ts";

let ctx: ConversationTestCtx;
let tenantBId: string;

const PRIMARY_SPACE = "spaces/PRIMARY_A";
const PRIMARY_SPACE_B = "spaces/PRIMARY_B";
const LINKED_USER = "users/g-linked-1";
const AMBIG_USER = "users/g-ambig-1";

function dmEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    platform: "google_chat",
    workspace_id: "spaces/DM_DEFAULT",
    channel_id: "spaces/DM_DEFAULT",
    user_id: LINKED_USER,
    kind: "mention",
    text: "hello",
    is_direct_message: true,
    raw: {},
    ...overrides,
  };
}

async function workspaceRows(workspace_id: string) {
  return await ctx.testDb.db
    .select()
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.platform, "google_chat"),
        eq(chatWorkspaces.workspace_id, workspace_id),
      ),
    );
}

async function identityRows(workspace_id: string) {
  return await ctx.testDb.db
    .select()
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, "google_chat"),
        eq(chatIdentities.workspace_id, workspace_id),
      ),
    );
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("dm-autoreg");

  // The sender's PRIMARY-space link — the tenant resolver for the DM
  // bootstrap. The DM space itself deliberately has NO rows.
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "google_chat",
    workspace_id: PRIMARY_SPACE,
    platform_user_id: LINKED_USER,
  });

  // Second tenant + user for the ambiguity guard: the same Google
  // platform user linked under TWO tenants (consultant scenario).
  const [tenantB] = await ctx.testDb.db
    .insert(tenants)
    .values({ slug: "t-dm-autoreg-b", display_name: "DM Autoreg B" })
    .returning();
  if (!tenantB) throw new Error("seed tenant B failed");
  tenantBId = tenantB.id;
  const [userB] = await ctx.testDb.db
    .insert(users)
    .values({ tenant_id: tenantBId, email: "dm-b@test.local", role: "member" })
    .returning();
  if (!userB) throw new Error("seed user B failed");

  await ctx.testDb.db.insert(chatIdentities).values([
    {
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "google_chat",
      workspace_id: PRIMARY_SPACE,
      platform_user_id: AMBIG_USER,
    },
    {
      tenant_id: tenantBId,
      user_id: userB.id,
      platform: "google_chat",
      workspace_id: PRIMARY_SPACE_B,
      platform_user_id: AMBIG_USER,
    },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("chat: DM auto-registration", () => {
  test("unlinked sender → denied dm_sender_not_linked, no rows written", async () => {
    const event = dmEvent({
      workspace_id: "spaces/DM_UNLINKED",
      channel_id: "spaces/DM_UNLINKED",
      user_id: "users/g-nobody",
    });
    const result = await ensureDmAutoRegistration(ctx.testDb.db, event);
    expect(result).toEqual({ denied: "dm_sender_not_linked" });
    expect(await workspaceRows("spaces/DM_UNLINKED")).toHaveLength(0);
    expect(await identityRows("spaces/DM_UNLINKED")).toHaveLength(0);
  });

  test("exactly one linked (tenant,user) pair → provisions workspace + identity + audits", async () => {
    const DM_SPACE = "spaces/DM_LINKED";
    const event = dmEvent({ workspace_id: DM_SPACE, channel_id: DM_SPACE });
    const result = await ensureDmAutoRegistration(ctx.testDb.db, event);
    if (!("workspace" in result)) {
      throw new Error(`expected provision, got denial: ${JSON.stringify(result)}`);
    }
    expect(result.user_id).toBe(ctx.user_id);
    expect(result.workspace.tenant_id).toBe(ctx.tenant_id);
    expect(result.workspace.platform).toBe("google_chat");
    expect(result.workspace.workspace_id).toBe(DM_SPACE);

    // The persisted row: default_channel = the DM channel, cipher
    // re-bound to the row's AAD holding the no-token sentinel (Google
    // outbound is the app-level service account; nothing reads this
    // back, but it must decrypt — a placeholder left unbound would
    // throw on any future read).
    const rows = await workspaceRows(DM_SPACE);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("workspace row missing");
    expect(row.id).toBe(result.workspace.id);
    expect(row.default_channel).toBe(DM_SPACE);
    const plaintext = decryptSecret(
      { ciphertext: row.bot_ciphertext, iv: row.bot_iv, auth_tag: row.bot_auth_tag },
      chatWorkspaceAad(row.tenant_id, row.id),
    );
    expect(plaintext).toBe("__no_workspace_token__");

    // The DM-space identity row — the dispatcher's exact-key lookup
    // resolves on this and every later message.
    const identities = await identityRows(DM_SPACE);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.tenant_id).toBe(ctx.tenant_id);
    expect(identities[0]?.user_id).toBe(ctx.user_id);
    expect(identities[0]?.platform_user_id).toBe(LINKED_USER);

    // Both audit rows carry metadata.kind = "dm_autoregister" so an
    // auto-provisioned install is distinguishable from the manual route.
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctx.tenant_id));
    const installed = audits.find(
      (a) =>
        a.action === AuditAction.CHAT_WORKSPACE_INSTALLED &&
        a.resource_id === row.id &&
        (a.metadata as Record<string, unknown> | null)?.kind === "dm_autoregister",
    );
    expect(installed).toBeTruthy();
    expect(installed?.actor_id).toBe(ctx.user_id);
    expect((installed!.metadata as Record<string, unknown>).workspace_id).toBe(DM_SPACE);
    const linked = audits.find(
      (a) =>
        a.action === AuditAction.CHAT_IDENTITY_LINKED &&
        (a.metadata as Record<string, unknown> | null)?.kind === "dm_autoregister" &&
        (a.metadata as Record<string, unknown> | null)?.platform_user_id === LINKED_USER,
    );
    expect(linked).toBeTruthy();
    expect(linked?.resource_id).toBe(ctx.user_id);
  });

  test("sender linked under two tenants → denied dm_sender_ambiguous, no rows written", async () => {
    const event = dmEvent({
      workspace_id: "spaces/DM_AMBIG",
      channel_id: "spaces/DM_AMBIG",
      user_id: AMBIG_USER,
    });
    const result = await ensureDmAutoRegistration(ctx.testDb.db, event);
    expect(result).toEqual({ denied: "dm_sender_ambiguous" });
    expect(await workspaceRows("spaces/DM_AMBIG")).toHaveLength(0);
    expect(await identityRows("spaces/DM_AMBIG")).toHaveLength(0);
  });

  test("not a DM / non-global-user-id platform / empty sender → denied not_dm_autoregistrable", async () => {
    // is_direct_message unset — a regular space mention never bootstraps.
    const notDm = dmEvent({ workspace_id: "spaces/NOT_DM", channel_id: "spaces/NOT_DM" });
    delete notDm.is_direct_message;
    expect(await ensureDmAutoRegistration(ctx.testDb.db, notDm)).toEqual({
      denied: "not_dm_autoregistrable",
    });

    // Slack user ids are workspace-scoped (PLATFORM_HAS_GLOBAL_USER_IDS
    // = false) — a cross-workspace match would bridge tenants.
    const slackDm = dmEvent({
      platform: "slack",
      workspace_id: "T_SLACK_DM",
      channel_id: "D_SLACK_DM",
      user_id: "U_SLACK",
    });
    expect(await ensureDmAutoRegistration(ctx.testDb.db, slackDm)).toEqual({
      denied: "not_dm_autoregistrable",
    });

    // Empty sender id can never match a linked identity — gate denies
    // before any query runs.
    const noUser = dmEvent({
      workspace_id: "spaces/DM_NO_USER",
      channel_id: "spaces/DM_NO_USER",
      user_id: "",
    });
    expect(await ensureDmAutoRegistration(ctx.testDb.db, noUser)).toEqual({
      denied: "not_dm_autoregistrable",
    });

    expect(await workspaceRows("spaces/NOT_DM")).toHaveLength(0);
    expect(await workspaceRows("spaces/DM_NO_USER")).toHaveLength(0);
  });

  test("second call for the same DM space is idempotent — one row, same workspace id", async () => {
    const DM_SPACE = "spaces/DM_TWICE";
    const event = dmEvent({ workspace_id: DM_SPACE, channel_id: DM_SPACE });

    const first = await ensureDmAutoRegistration(ctx.testDb.db, event);
    const second = await ensureDmAutoRegistration(ctx.testDb.db, event);
    if (!("workspace" in first) || !("workspace" in second)) {
      throw new Error("expected both calls to provision/resolve a workspace");
    }
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.user_id).toBe(ctx.user_id);

    const rows = await workspaceRows(DM_SPACE);
    expect(rows).toHaveLength(1);
    expect(await identityRows(DM_SPACE)).toHaveLength(1);

    // The conflict path must not clobber the winner's bound cipher —
    // it stays decryptable under the row AAD after the second call.
    const row = rows[0];
    if (!row) throw new Error("workspace row missing");
    const plaintext = decryptSecret(
      { ciphertext: row.bot_ciphertext, iv: row.bot_iv, auth_tag: row.bot_auth_tag },
      chatWorkspaceAad(row.tenant_id, row.id),
    );
    expect(plaintext).toBe("__no_workspace_token__");
  });
});
