import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { chatIdentities, chatWorkspaces, users } from "../db/schema/index.ts";
import type { InboundChatPlatform } from "./types.ts";

export type ChatIdentityRow = typeof chatIdentities.$inferSelect;

type ChatIdentityLinkRefusal = "workspace_not_found" | "user_not_found" | "already_linked";

export class ChatIdentityLinkRefusedError extends Error {
  constructor(
    readonly refusal: ChatIdentityLinkRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ChatIdentityLinkRefusedError";
  }
}

interface ChatIdentityLinkInput {
  principal: ResolvedPrincipal;
  body: {
    user_id: string;
    platform: InboundChatPlatform;
    workspace_id: string;
    platform_user_id: string;
  };
}

export async function listChatIdentities(db: Db, tenant_id: string): Promise<ChatIdentityRow[]> {
  return db.select().from(chatIdentities).where(eq(chatIdentities.tenant_id, tenant_id));
}

export async function linkChatIdentity(
  db: Db,
  input: ChatIdentityLinkInput,
): Promise<ChatIdentityRow | undefined> {
  const { principal, body } = input;
  const [ws] = await db
    .select({ id: chatWorkspaces.id })
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.tenant_id, principal.tenant_id),
        eq(chatWorkspaces.platform, body.platform),
        eq(chatWorkspaces.workspace_id, body.workspace_id),
      ),
    )
    .limit(1);
  if (!ws) throw new ChatIdentityLinkRefusedError("workspace_not_found", "chat_workspace");

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenant_id, principal.tenant_id), eq(users.id, body.user_id)))
    .limit(1);
  if (!user) throw new ChatIdentityLinkRefusedError("user_not_found", "user");

  let row: ChatIdentityRow | undefined;
  await db.transaction(async (tx) => {
    const insertResult = await tx
      .insert(chatIdentities)
      .values({
        tenant_id: principal.tenant_id,
        user_id: body.user_id,
        platform: body.platform,
        workspace_id: body.workspace_id,
        platform_user_id: body.platform_user_id,
      })
      .onConflictDoNothing({
        target: [
          chatIdentities.platform,
          chatIdentities.workspace_id,
          chatIdentities.platform_user_id,
        ],
      })
      .returning();
    row = insertResult[0];
    if (!row) {
      throw new ChatIdentityLinkRefusedError(
        "already_linked",
        `chat user ${body.platform}:${body.workspace_id}:${body.platform_user_id} is already linked`,
      );
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CHAT_IDENTITY_LINKED,
        resource_type: "chat_identity",
        resource_id: body.user_id,
        result: "success",
        metadata: {
          kind: "manual",
          platform: body.platform,
          platform_user_id: body.platform_user_id,
        },
      },
      tx,
    );
  });
  return row;
}

export async function unlinkChatIdentity(
  db: Db,
  principal: ResolvedPrincipal,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(chatIdentities)
    .where(and(eq(chatIdentities.tenant_id, principal.tenant_id), eq(chatIdentities.id, id)))
    .limit(1);
  if (!row) return false;
  await db.transaction(async (tx) => {
    await tx
      .delete(chatIdentities)
      .where(and(eq(chatIdentities.tenant_id, principal.tenant_id), eq(chatIdentities.id, id)));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CHAT_IDENTITY_UNLINKED,
        resource_type: "chat_identity",
        resource_id: row.user_id,
        result: "success",
        metadata: {
          kind: "manual_unlink",
          platform: row.platform,
          platform_user_id: row.platform_user_id,
        },
      },
      tx,
    );
  });
  return true;
}
