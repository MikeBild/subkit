import { and, eq } from "drizzle-orm";
import { chatIdentities, chatWorkspaces, type Db } from "../../../../db/index.ts";

export async function findSlackIdentity(db: Db, workspaceId: string, platformUserId: string) {
  // tenant-filter:exempt — platform user-identity lookup pre-tenant (mirrors dispatcher.ts)
  const [identity] = await db
    .select({ user_id: chatIdentities.user_id, tenant_id: chatIdentities.tenant_id })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, "slack"),
        eq(chatIdentities.workspace_id, workspaceId),
        eq(chatIdentities.platform_user_id, platformUserId),
      ),
    )
    .limit(1);
  return identity ?? null;
}

export async function findSlackWorkspace(db: Db, workspaceId: string) {
  // tenant-filter:exempt — platform/workspace_id lookup pre-tenant (mirrors dispatcher.ts)
  const [workspace] = await db
    .select({ id: chatWorkspaces.id, tenant_id: chatWorkspaces.tenant_id })
    .from(chatWorkspaces)
    .where(and(eq(chatWorkspaces.platform, "slack"), eq(chatWorkspaces.workspace_id, workspaceId)))
    .limit(1);
  return workspace ?? null;
}
