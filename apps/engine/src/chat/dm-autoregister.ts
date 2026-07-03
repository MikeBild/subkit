// Fail-closed DM auto-registration.
//
// One `chat_workspaces` row per space means a 1:1 DM space would need a
// manual admin install before the bot ever answers a direct message —
// unworkable for a team. This module bootstraps the DM space from the
// sender's EXISTING linked identity instead:
//
//   - Gated on `PLATFORM_HAS_GLOBAL_USER_IDS`: the cross-workspace
//     identity match below relaxes the workspace-scoping invariant and
//     is only sound when a platform user id names one human globally.
//     Google `users/<People-id>` does (and arrives JWT-verified);
//     Slack `U…` / Teams ids are workspace-scoped — matching them
//     across workspaces would BRIDGE tenants, so those platforms stay
//     off until a sound scoping exists.
//   - Fail-closed on the match: an unlinked sender is denied
//     (`dm_sender_not_linked`); a sender linked in MORE than one
//     (tenant, user) pair — e.g. a consultant in two subkit tenants —
//     is denied (`dm_sender_ambiguous`) rather than guessing a tenant.
//   - Exactly one match provisions the DM space under that tenant and
//     seeds the DM-space identity row, so the dispatcher's existing
//     exact-key lookups resolve on this and every later message with
//     ZERO dispatcher changes. The turn then runs under the linked
//     user's real roles + the read-only chat palette — no elevation.
//
// No schema change: `chat_workspaces` + `chat_identities` already carry
// every needed column; the cipher columns get the same placeholder →
// row-bound-AAD sentinel dance the install route uses for google
// (outbound auth is the app-level service account; nothing reads the
// per-workspace token back).

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

/**
 * Provision a `chat_workspaces` + `chat_identities` pair for an
 * unregistered 1:1 DM space when (and only when) the sender is already
 * linked in exactly one tenant. Called from the chat.event worker's
 * unknown-workspace branch; every deny falls through to the caller's
 * existing drop path.
 */
export async function ensureDmAutoRegistration(
  db: Db,
  event: ChatEvent,
): Promise<DmAutoRegistrationResult> {
  // Only USER-INITIATED events may provision. Without this gate a
  // `removed_from_space` (which also carries is_direct_message) would
  // resurrect the workspace + identity rows and emit an "installed"
  // audit at the exact moment the user removes the app.
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

  // Cross-workspace identity match on the SUBSET key (platform,
  // platform_user_id) — never on workspace_id, never trusting the
  // payload's space name for tenant resolution. The linked identity IS
  // the tenant resolver.
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
    // Same placeholder → row-bound-AAD dance as the install route: the
    // NOT-NULL cipher columns need the row id for the AAD.
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
      // Targetless on purpose: chat_workspaces carries BOTH a
      // tenant-scoped unique index and the GLOBAL (platform,
      // workspace_id) one. A targeted arbiter only suppresses conflicts
      // on ITS index — two truly concurrent first-DM jobs would have
      // the loser throw a raw unique_violation on the global index.
      // Targetless suppresses both; the re-select below is the truth
      // check (both racers resolved the same tenant via the fail-closed
      // identity match, so the winner's row is always ours).
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
      // Concurrent first-DM race: a sibling job won the insert. The
      // winner already bound the cipher — reuse its row untouched.
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
    // Unreachable (the tx throws first), narrows the type for TS.
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
