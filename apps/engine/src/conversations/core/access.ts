import { isBuiltinAdmin, isOwner, isOwnerOrAdmin } from "../../rbac/core/owner.ts";
import { getTaskRunMarker } from "./draft.ts";

/**
 * Who may read, write, delete and share a conversation. Pure functions over
 * plain facts; the shell loads the row and the principal and decides here.
 *
 * - Read: the owner; anyone in the workspace when the conversation is shared
 *   with the team; admins only for workspace-owned rows without an owner.
 *   Admins never read another person's private conversation.
 * - Write (messages, uploads, answers, patch): the owner only. A shared
 *   conversation can be forked by others, not continued.
 * - Delete: the owner or an admin.
 * - Task-run conversations keep their own rule: owner or admin, and a sealed
 *   run is readable by admins only.
 */

export const CONVERSATION_VISIBILITIES = ["private", "team"] as const;
export type ConversationVisibility = (typeof CONVERSATION_VISIBILITIES)[number];

export interface ConversationViewer {
  readonly id: string;
  readonly tenant_id: string;
  readonly is_admin: boolean;
}

export interface ConversationAccessRow {
  readonly tenant_id: string;
  readonly owner_id: string | null;
  readonly visibility: ConversationVisibility;
  readonly task_run: { readonly sealed: boolean } | null;
}

export function conversationViewerOf(principal: {
  readonly id: string;
  readonly tenant_id: string;
  readonly roles?: readonly string[];
}): ConversationViewer {
  return {
    id: principal.id,
    tenant_id: principal.tenant_id,
    is_admin: isBuiltinAdmin(principal.roles),
  };
}

export function isConversationVisibility(value: unknown): value is ConversationVisibility {
  return value === "private" || value === "team";
}

export function conversationAccessRowOf(row: {
  readonly tenant_id: string;
  readonly owner_id: string | null;
  readonly visibility: string;
  readonly draft: unknown;
}): ConversationAccessRow {
  const marker = getTaskRunMarker(row.draft);
  return {
    tenant_id: row.tenant_id,
    owner_id: row.owner_id,
    visibility: isConversationVisibility(row.visibility) ? row.visibility : "private",
    task_run: marker ? { sealed: marker.sealed === true } : null,
  };
}

function sameTenant(viewer: ConversationViewer, row: ConversationAccessRow): boolean {
  return viewer.tenant_id === row.tenant_id;
}

function workspaceOwned(viewer: ConversationViewer, row: ConversationAccessRow): boolean {
  return row.owner_id === null && viewer.is_admin;
}

export function canReadConversation(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
): boolean {
  if (!sameTenant(viewer, row)) return false;
  if (row.task_run) {
    if (viewer.is_admin) return true;
    return !row.task_run.sealed && isOwner(viewer, row.owner_id);
  }
  return isOwner(viewer, row.owner_id) || row.visibility === "team" || workspaceOwned(viewer, row);
}

export function canWriteConversation(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
): boolean {
  if (!sameTenant(viewer, row)) return false;
  if (row.task_run) return isOwnerOrAdmin(viewer, row.owner_id);
  return isOwner(viewer, row.owner_id) || workspaceOwned(viewer, row);
}

export function canDeleteConversation(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
): boolean {
  return sameTenant(viewer, row) && isOwnerOrAdmin(viewer, row.owner_id);
}

/** Admins see that a conversation exists (metadata only) even when they cannot read it. */
export function canSeeConversation(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
): boolean {
  return canReadConversation(viewer, row) || (sameTenant(viewer, row) && viewer.is_admin);
}

export type ConversationWriteRefusal = "not_found" | "read_only";

/** Why a write is refused: an unreadable row is "not_found" so nothing leaks about it. */
export function conversationWriteRefusal(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
): ConversationWriteRefusal | null {
  if (canWriteConversation(viewer, row)) return null;
  return canReadConversation(viewer, row) ? "read_only" : "not_found";
}

export type VisibilityAction = "share" | "unshare";

export const visibilityTransitions: Readonly<
  Record<ConversationVisibility, Partial<Record<VisibilityAction, ConversationVisibility>>>
> = {
  private: { share: "team" },
  team: { unshare: "private" },
};

export type VisibilityRejection =
  | "not_found"
  | "not_owner"
  | "task_run"
  | "already_shared"
  | "already_private";

export type VisibilityMove =
  | { readonly kind: "moved"; readonly visibility: ConversationVisibility }
  | { readonly kind: "rejected"; readonly reason: VisibilityRejection };

/** Share or unshare: only the owner, never a task-run conversation. */
export function moveConversationVisibility(
  viewer: ConversationViewer,
  row: ConversationAccessRow,
  action: VisibilityAction,
): VisibilityMove {
  if (!canReadConversation(viewer, row)) return { kind: "rejected", reason: "not_found" };
  if (!isOwner(viewer, row.owner_id)) return { kind: "rejected", reason: "not_owner" };
  if (row.task_run) return { kind: "rejected", reason: "task_run" };
  const next = visibilityTransitions[row.visibility][action];
  if (next) return { kind: "moved", visibility: next };
  return {
    kind: "rejected",
    reason: action === "share" ? "already_shared" : "already_private",
  };
}
