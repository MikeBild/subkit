import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { chatIdentities, chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { chatWorkspaceAad } from "./api.ts";
import { type ChatEvent, PLATFORM_HAS_GLOBAL_USER_IDS } from "./types.ts";

export type DmAutoRegistrationDenial =
  | "not_dm_autoregistrable"
  | "dm_sender_not_linked"
  | "dm_sender_ambiguous";

export type DmAutoRegistrationResult =
  | { workspace: typeof chatWorkspaces.$inferSelect; user_id: string }
  | { denied: DmAutoRegistrationDenial };

export async function ensureDmAutoRegistration(
  db: Db,
  event: ChatEvent,
): Promise<DmAutoRegistrationResult> {
  const userInitiated =
    event.kind === "mention" ||
    event.kind === "slash_command" ||
    event.kind === "interaction" ||
    (event.kind === "system" && event.system_event === "added_to_space");
  if (
    !userInitiated ||
    event.is_direct_message !== true ||
    !PLATFORM_HAS_GLOBAL_USER_IDS[event.platform] ||
    !event.user_id
  ) {
    return { denied: "not_dm_autoregistrable" };
  }

  // tenant-filter:exempt — DM bootstrap is pre-tenant by construction;
  // the fail-closed distinct-pair rule below is the isolation guard.
  const rows = await db
    .select({ tenant_id: chatIdentities.tenant_id, user_id: chatIdentities.user_id })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, event.platform),
        eq(chatIdentities.platform_user_id, event.user_id),
      ),
    );
  const pairs = new Map<string, { tenant_id: string; user_id: string }>();
  for (const row of rows) pairs.set(`${row.tenant_id}:${row.user_id}`, row);
  if (pairs.size === 0) return { denied: "dm_sender_not_linked" };
  if (pairs.size > 1) return { denied: "dm_sender_ambiguous" };
  const match = [...pairs.values()][0];
  if (!match) return { denied: "dm_sender_not_linked" };
  const { tenant_id, user_id } = match;

  let workspace: typeof chatWorkspaces.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const placeholder = encryptSecret("__placeholder__");
    const inserted = await tx
      .insert(chatWorkspaces)
      .values({
        tenant_id,
        platform: event.platform,
        workspace_id: event.workspace_id,
        default_channel: event.channel_id || null,
        bot_ciphertext: placeholder.ciphertext,
        bot_iv: placeholder.iv,
        bot_auth_tag: placeholder.auth_tag,
      })
      .onConflictDoNothing()
      .returning();
    workspace = inserted[0];
    if (workspace) {
      const bound = encryptSecret(
        "__no_workspace_token__",
        chatWorkspaceAad(workspace.tenant_id, workspace.id),
      );
      await tx
        .update(chatWorkspaces)
        .set({
          bot_ciphertext: bound.ciphertext,
          bot_iv: bound.iv,
          bot_auth_tag: bound.auth_tag,
          updated_at: new Date(),
        })
        .where(eq(chatWorkspaces.id, workspace.id));
      await auditAwait(
        {
          tenant_id,
          actor_type: "user",
          actor_id: user_id,
          action: AuditAction.CHAT_WORKSPACE_INSTALLED,
          resource_type: "chat_workspace",
          resource_id: workspace.id,
          result: "success",
          metadata: {
            kind: "dm_autoregister",
            platform: event.platform,
            workspace_id: event.workspace_id,
          },
        },
        tx,
      );
    } else {
      const [existing] = await tx
        .select()
        .from(chatWorkspaces)
        .where(
          and(
            eq(chatWorkspaces.tenant_id, tenant_id),
            eq(chatWorkspaces.platform, event.platform),
            eq(chatWorkspaces.workspace_id, event.workspace_id),
          ),
        )
        .limit(1);
      workspace = existing;
    }
    if (!workspace) {
      throw new Error("dm-autoregister: workspace row missing after insert/conflict");
    }

    const linked = await tx
      .insert(chatIdentities)
      .values({
        tenant_id,
        user_id,
        platform: event.platform,
        workspace_id: event.workspace_id,
        platform_user_id: event.user_id,
      })
      .onConflictDoNothing({
        target: [
          chatIdentities.platform,
          chatIdentities.workspace_id,
          chatIdentities.platform_user_id,
        ],
      })
      .returning();
    if (linked[0]) {
      await auditAwait(
        {
          tenant_id,
          actor_type: "user",
          actor_id: user_id,
          action: AuditAction.CHAT_IDENTITY_LINKED,
          resource_type: "chat_identity",
          resource_id: user_id,
          result: "success",
          metadata: {
            kind: "dm_autoregister",
            platform: event.platform,
            platform_user_id: event.user_id,
          },
        },
        tx,
      );
    }
  });

  if (!workspace) {
    return { denied: "not_dm_autoregistrable" };
  }
  logger.info({
    module: "chat",
    action: "dm_autoregister.provisioned",
    msg: "DM space auto-registered from the sender's linked identity",
    tenant_id,
    platform: event.platform,
    workspace_row_id: workspace.id,
    workspace_id_native: event.workspace_id,
  });
  return { workspace, user_id };
}
