import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { AuditAction, ChatMessageDeniedMetadataSchema, SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { withSystemScope } from "../db/index.ts";
import { auditLog } from "../db/schema/audit.ts";
import { chatIdentities, chatWorkspaces } from "../db/schema/index.ts";
import {
  type ChatPlatform,
  type InboundChatPlatform,
  PLATFORM_HAS_GLOBAL_USER_IDS,
} from "./types.ts";

const WORKSPACE_NOT_INSTALLED = "workspace_not_installed";

export interface PendingChatSpace {
  platform: InboundChatPlatform;
  workspace_id: string;
  display_name: string | null;
  installer_platform_user_id: string;
}

export async function listPendingSpacesForPrincipal(
  db: Db,
  principal: { tenant_id: string; user_id: string },
  opts?: { platform?: InboundChatPlatform },
): Promise<PendingChatSpace[]> {
  if (opts?.platform && !PLATFORM_HAS_GLOBAL_USER_IDS[opts.platform]) return [];

  const identities = await db
    .select({ platform: chatIdentities.platform, pid: chatIdentities.platform_user_id })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.tenant_id, principal.tenant_id),
        eq(chatIdentities.user_id, principal.user_id),
      ),
    );

  const ownedPairs = new Set<string>();
  const callerPids = new Set<string>();
  for (const row of identities) {
    const platform = row.platform as ChatPlatform;
    if (!PLATFORM_HAS_GLOBAL_USER_IDS[platform]) continue;
    if (opts?.platform && platform !== opts.platform) continue;
    ownedPairs.add(`${platform}:${row.pid}`);
    callerPids.add(row.pid);
  }
  if (callerPids.size === 0) return [];

  const senderPredicates: SQL[] = [...callerPids].map(
    (pid) => sql`${auditLog.metadata} ->> 'sender_platform_user_id' = ${pid}`,
  );
  const rows = await db
    .select({ metadata: auditLog.metadata, ts: auditLog.ts })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, SYSTEM_TENANT_ID),
        eq(auditLog.action, AuditAction.CHAT_MESSAGE_DENIED),
        eq(auditLog.reason, WORKSPACE_NOT_INSTALLED),
        or(...senderPredicates),
      ),
    )
    .orderBy(desc(auditLog.ts));

  const byWorkspace = new Map<string, PendingChatSpace>();
  for (const row of rows) {
    const parsed = ChatMessageDeniedMetadataSchema.safeParse(row.metadata);
    if (!parsed.success) continue;
    const md = parsed.data;
    const sender = md.sender_platform_user_id;
    if (!sender) continue;
    const platform = md.platform as ChatPlatform;
    if (!PLATFORM_HAS_GLOBAL_USER_IDS[platform]) continue;
    if (!ownedPairs.has(`${platform}:${sender}`)) continue;
    if (opts?.platform && platform !== opts.platform) continue;
    if (byWorkspace.has(md.workspace_id_native)) continue;
    byWorkspace.set(md.workspace_id_native, {
      platform: platform as InboundChatPlatform,
      workspace_id: md.workspace_id_native,
      display_name: md.space_display_name ?? null,
      installer_platform_user_id: sender,
    });
  }
  if (byWorkspace.size === 0) return [];

  const candidateWorkspaceIds = [...byWorkspace.keys()];
  // tenant-filter:exempt — deliberate global existence check; the
  // isolation guard is the caller-owned identity join in step 3, not a
  // tenant predicate here.
  const installed = await withSystemScope(db, "pending chat space global install check", (tx) =>
    tx
      .select({ platform: chatWorkspaces.platform, workspace_id: chatWorkspaces.workspace_id })
      .from(chatWorkspaces)
      .where(inArray(chatWorkspaces.workspace_id, candidateWorkspaceIds)),
  );
  const installedKeys = new Set(installed.map((r) => `${r.platform}:${r.workspace_id}`));

  return [...byWorkspace.values()].filter(
    (c) => !installedKeys.has(`${c.platform}:${c.workspace_id}`),
  );
}
