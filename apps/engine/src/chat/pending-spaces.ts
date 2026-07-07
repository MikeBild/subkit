// Pending chat-space discovery for `sk chat install-space`.
//
// A named chat space (Google Chat "space", not a 1:1 DM) does NOT
// auto-register — the chat.event worker drops the first message and
// records a `CHAT_MESSAGE_DENIED` audit row under `SYSTEM_TENANT_ID`
// with `reason = "workspace_not_installed"` (see
// queue/handlers/chat-event.ts). This module reads those rows back so
// the CLI can list "spaces you just added the app to" and install one
// without the operator hand-copying a `spaces/<id>` from the logs.
//
// ISOLATION MODEL — this is the load-bearing part. The SYSTEM deny pool
// is tenant-blind (no owning tenant is known at deny time). The ONLY
// tenant-safe projection key is an EXISTING, JWT-verified `chat_identity`
// owned by the caller:
//
//   1. Resolve the caller's own platform user ids, tenant-scoped, and
//      keep only platforms whose native user id is tenant-global
//      (`PLATFORM_HAS_GLOBAL_USER_IDS`) — a workspace-scoped Slack/Teams
//      id can never be soundly matched against a tenant-blind pool.
//   2. Match deny rows on `metadata.sender_platform_user_id` == one of
//      those ids (the sender id is itself only written for global-id
//      platforms, so a `null` sender never matches — NULL-safe).
//   3. Re-check the (platform, sender) pair in code (defense in depth),
//      exclude spaces already installed anywhere (the global
//      `(platform, workspace_id)` unique index would 409 the install),
//      and return the caller's own verified id as `installer_platform_user_id`.
//
// A caller with no `chat_identity` (never DM'd the app) gets an empty
// list — there is no directory / email fallback, by design.

import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { AuditAction, ChatMessageDeniedMetadataSchema, SYSTEM_TENANT_ID } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
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
  /** Platform-native id — e.g. Google `spaces/<id>`. */
  workspace_id: string;
  /** Human-friendly name when the platform supplied one, else null. */
  display_name: string | null;
  /** The caller's own JWT-verified platform user id, ready to pass as
   *  `installer_platform_user_id` to `POST /v1/chat/workspaces`. */
  installer_platform_user_id: string;
}

/**
 * Spaces the caller was denied in (added the app to but not yet
 * installed), attributable to them via an existing verified identity.
 * `opts.platform` narrows to one platform. Returns `[]` when the caller
 * has no usable (global-id) identity or nothing is pending.
 */
export async function listPendingSpacesForPrincipal(
  db: Db,
  principal: { tenant_id: string; user_id: string },
  opts?: { platform?: InboundChatPlatform },
): Promise<PendingChatSpace[]> {
  // A requested non-global-id platform can never be discovered — fail
  // closed before touching the DB.
  if (opts?.platform && !PLATFORM_HAS_GLOBAL_USER_IDS[opts.platform]) return [];

  // 1. Caller's own verified ids, tenant-scoped, global-id platforms only.
  const identities = await db
    .select({ platform: chatIdentities.platform, pid: chatIdentities.platform_user_id })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.tenant_id, principal.tenant_id),
        eq(chatIdentities.user_id, principal.user_id),
      ),
    );

  // Caller-owned (platform, id) pairs on global-id platforms — the
  // authorization set every candidate must belong to.
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

  // 2. Deny rows whose sender is one of the caller's ids. OR of
  //    single-value predicates (driver-agnostic; the set is tiny).
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

  // 3. Validate + attribute + dedup (newest wins; rows are ts-desc).
  const byWorkspace = new Map<string, PendingChatSpace>();
  for (const row of rows) {
    const parsed = ChatMessageDeniedMetadataSchema.safeParse(row.metadata);
    if (!parsed.success) continue;
    const md = parsed.data;
    const sender = md.sender_platform_user_id;
    if (!sender) continue; // NULL-safe: a null sender is never attributable
    const platform = md.platform as ChatPlatform;
    if (!PLATFORM_HAS_GLOBAL_USER_IDS[platform]) continue; // defense in depth
    if (!ownedPairs.has(`${platform}:${sender}`)) continue; // authorization
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

  // 4. Exclude spaces already installed ANYWHERE — the global
  //    `(platform, workspace_id)` unique index means an existing install
  //    (even in another tenant) would 409 the caller's install. Surfacing
  //    it would only produce a dead pick.
  const candidateWorkspaceIds = [...byWorkspace.keys()];
  // tenant-filter:exempt — deliberate global existence check; the
  // isolation guard is the caller-owned identity join in step 3, not a
  // tenant predicate here.
  const installed = await db
    .select({ platform: chatWorkspaces.platform, workspace_id: chatWorkspaces.workspace_id })
    .from(chatWorkspaces)
    .where(inArray(chatWorkspaces.workspace_id, candidateWorkspaceIds));
  const installedKeys = new Set(installed.map((r) => `${r.platform}:${r.workspace_id}`));

  return [...byWorkspace.values()].filter(
    (c) => !installedKeys.has(`${c.platform}:${c.workspace_id}`),
  );
}
