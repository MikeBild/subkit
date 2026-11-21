import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { encryptSecret } from "../crypto/index.ts";
import type { Db } from "../db/client.ts";
import { chatIdentities, chatWorkspaces } from "../db/schema/index.ts";
import { chatWorkspaceAad } from "./api.ts";
import { type InboundChatPlatform, PLATFORM_HAS_GLOBAL_USER_IDS } from "./types.ts";

export type ChatWorkspaceRow = typeof chatWorkspaces.$inferSelect;

type ChatWorkspaceInstallRefusal =
  | "claimed_elsewhere"
  | "platform_unsupported"
  | "installer_not_owned"
  | "already_installed"
  | "installer_linked_elsewhere";

export class ChatWorkspaceInstallRefusedError extends Error {
  constructor(
    readonly refusal: ChatWorkspaceInstallRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ChatWorkspaceInstallRefusedError";
  }
}

interface ChatWorkspaceInstallInput {
  principal: ResolvedPrincipal;
  body: {
    platform: InboundChatPlatform;
    workspace_id: string;
    bot_token?: string | undefined;
    installer_platform_user_id: string;
    default_channel?: string | null | undefined;
  };
}

export async function listChatWorkspaces(db: Db, tenant_id: string): Promise<ChatWorkspaceRow[]> {
  return db.select().from(chatWorkspaces).where(eq(chatWorkspaces.tenant_id, tenant_id));
}

export async function findChatWorkspace(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<ChatWorkspaceRow | null> {
  const [row] = await db
    .select()
    .from(chatWorkspaces)
    .where(and(eq(chatWorkspaces.tenant_id, tenant_id), eq(chatWorkspaces.id, id)))
    .limit(1);
  return row ?? null;
}

export async function installChatWorkspace(
  db: Db,
  input: ChatWorkspaceInstallInput,
): Promise<ChatWorkspaceRow | undefined> {
  // tenant-filter:exempt — global uniqueness check spans tenants by
  // design; we never expose the foreign row, only the conflict.
  const [foreignRow] = await db
    .select({ tenant_id: chatWorkspaces.tenant_id })
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.platform, input.body.platform),
        eq(chatWorkspaces.workspace_id, input.body.workspace_id),
      ),
    )
    .limit(1);
  if (foreignRow && foreignRow.tenant_id !== input.principal.tenant_id) {
    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.CHAT_WORKSPACE_INSTALLED,
        resource_type: "chat_workspace",
        resource_id: null,
        result: "denied",
        reason: "workspace_already_claimed",
        metadata: {
          platform: input.body.platform,
          workspace_id: input.body.workspace_id,
        },
      },
      db,
    );
    throw new ChatWorkspaceInstallRefusedError(
      "claimed_elsewhere",
      `${input.body.platform} workspace ${input.body.workspace_id} is already installed in another tenant`,
    );
  }

  if (input.body.platform === "teams") {
    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.CHAT_WORKSPACE_INSTALLED,
        resource_type: "chat_workspace",
        resource_id: null,
        result: "denied",
        reason: "platform_unsupported",
        metadata: { platform: input.body.platform, workspace_id: input.body.workspace_id },
      },
      db,
    );
    throw new ChatWorkspaceInstallRefusedError(
      "platform_unsupported",
      "teams chat spaces are not supported yet — no adapter is hydrated for the teams platform",
    );
  }

  if (PLATFORM_HAS_GLOBAL_USER_IDS[input.body.platform]) {
    const [owned] = await db
      .select({ id: chatIdentities.id })
      .from(chatIdentities)
      .where(
        and(
          eq(chatIdentities.tenant_id, input.principal.tenant_id),
          eq(chatIdentities.user_id, input.principal.id),
          eq(chatIdentities.platform, input.body.platform),
          eq(chatIdentities.platform_user_id, input.body.installer_platform_user_id),
        ),
      )
      .limit(1);
    if (!owned) {
      await auditAwait(
        {
          tenant_id: input.principal.tenant_id,
          actor_type: input.principal.kind,
          actor_id: input.principal.id,
          action: AuditAction.CHAT_WORKSPACE_INSTALLED,
          resource_type: "chat_workspace",
          resource_id: null,
          result: "denied",
          reason: "installer_not_owned",
          metadata: {
            platform: input.body.platform,
            workspace_id: input.body.workspace_id,
            installer_platform_user_id: input.body.installer_platform_user_id,
          },
        },
        db,
      );
      throw new ChatWorkspaceInstallRefusedError(
        "installer_not_owned",
        "installer_platform_user_id is not a verified identity you own — " +
          "DM the app once so your account links, then retry the install",
      );
    }
  }

  const placeholder = encryptSecret("__placeholder__");
  let row: ChatWorkspaceRow | undefined;
  let installerLinked = false;
  await db.transaction(async (tx) => {
    const insertResult = await tx
      .insert(chatWorkspaces)
      .values({
        tenant_id: input.principal.tenant_id,
        platform: input.body.platform,
        workspace_id: input.body.workspace_id,
        default_channel: input.body.default_channel ?? null,
        bot_ciphertext: placeholder.ciphertext,
        bot_iv: placeholder.iv,
        bot_auth_tag: placeholder.auth_tag,
      })
      .onConflictDoNothing({
        target: [chatWorkspaces.tenant_id, chatWorkspaces.platform, chatWorkspaces.workspace_id],
      })
      .returning();
    row = insertResult[0];
    if (!row) {
      throw new ChatWorkspaceInstallRefusedError(
        "already_installed",
        `${input.body.platform} workspace ${input.body.workspace_id} is already installed in this tenant`,
      );
    }

    const bound = encryptSecret(
      input.body.bot_token ?? "__no_workspace_token__",
      chatWorkspaceAad(row.tenant_id, row.id),
    );
    await tx
      .update(chatWorkspaces)
      .set({
        bot_ciphertext: bound.ciphertext,
        bot_iv: bound.iv,
        bot_auth_tag: bound.auth_tag,
        updated_at: new Date(),
      })
      .where(eq(chatWorkspaces.id, row.id));

    const linkResult = await tx
      .insert(chatIdentities)
      .values({
        tenant_id: input.principal.tenant_id,
        user_id: input.principal.id,
        platform: input.body.platform,
        workspace_id: input.body.workspace_id,
        platform_user_id: input.body.installer_platform_user_id,
      })
      .onConflictDoNothing({
        target: [
          chatIdentities.platform,
          chatIdentities.workspace_id,
          chatIdentities.platform_user_id,
        ],
      })
      .returning();
    if (linkResult[0]) {
      installerLinked = true;
    } else {
      // tenant-filter:exempt — the chat_identities row is keyed by
      // the platform identity tuple (platform, workspace_id,
      // platform_user_id) which is globally unique. A different-
      // tenant binding for the same Slack id is the exact conflict
      // this branch is designed to surface; adding a tenant_id
      // predicate here would hide it and silently overwrite the
      // operator's link state.
      const [existing] = await tx
        .select({ user_id: chatIdentities.user_id })
        .from(chatIdentities)
        .where(
          and(
            eq(chatIdentities.platform, input.body.platform),
            eq(chatIdentities.workspace_id, input.body.workspace_id),
            eq(chatIdentities.platform_user_id, input.body.installer_platform_user_id),
          ),
        )
        .limit(1);
      if (existing && existing.user_id !== input.principal.id) {
        await auditAwait(
          {
            tenant_id: input.principal.tenant_id,
            actor_type: input.principal.kind,
            actor_id: input.principal.id,
            action: AuditAction.CHAT_IDENTITY_LINKED,
            resource_type: "chat_identity",
            resource_id: input.principal.id,
            result: "denied",
            reason: "platform_user_already_linked_to_other_subkit_user",
            metadata: {
              kind: "install",
              platform: input.body.platform,
              platform_user_id: input.body.installer_platform_user_id,
              workspace_id: input.body.workspace_id,
            },
          },
          db,
        );
        throw new ChatWorkspaceInstallRefusedError(
          "installer_linked_elsewhere",
          `slack user ${input.body.installer_platform_user_id} in workspace ` +
            `${input.body.workspace_id} is already linked to a different subkit user; ` +
            "unlink it via DELETE /v1/chat/identities/<id> and retry the install",
        );
      }
    }

    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.CHAT_WORKSPACE_INSTALLED,
        resource_type: "chat_workspace",
        resource_id: row.id,
        result: "success",
        metadata: {
          platform: input.body.platform,
          workspace_id: input.body.workspace_id,
        },
      },
      tx,
    );
    await auditAwait(
      {
        tenant_id: input.principal.tenant_id,
        actor_type: input.principal.kind,
        actor_id: input.principal.id,
        action: AuditAction.CHAT_IDENTITY_LINKED,
        resource_type: "chat_identity",
        resource_id: input.principal.id,
        result: "success",
        ...(installerLinked ? {} : { reason: "install_noop" }),
        metadata: {
          kind: installerLinked ? "install" : "install_noop",
          platform: input.body.platform,
          platform_user_id: input.body.installer_platform_user_id,
        },
      },
      tx,
    );
  });
  return row;
}

export async function removeChatWorkspace(
  db: Db,
  principal: ResolvedPrincipal,
  id: string,
): Promise<ChatWorkspaceRow | null> {
  const row = await findChatWorkspace(db, principal.tenant_id, id);
  if (!row) return null;

  await db.transaction(async (tx) => {
    await tx
      .delete(chatWorkspaces)
      .where(and(eq(chatWorkspaces.tenant_id, principal.tenant_id), eq(chatWorkspaces.id, id)));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CHAT_WORKSPACE_REMOVED,
        resource_type: "chat_workspace",
        resource_id: row.id,
        result: "success",
        metadata: { platform: row.platform, workspace_id: row.workspace_id },
      },
      tx,
    );
  });
  return row;
}
