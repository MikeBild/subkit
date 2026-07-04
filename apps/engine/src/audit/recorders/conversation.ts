// Conversation audit recorders.
//
// State-changing paths against a conversation's persisted state land here:
//   - load_skill tool → recordConversationSkillLoaded (mutates
//     conversations.loaded_skills, tenant-visible state that survives
//     session resumption)
//
// The metadata shape is locked at the recorder level so a schema drift in
// one call site cannot silently desynchronise the audit trail. Bind the
// `executor` to the same db the state mutation runs on so the audit write
// is deterministic for tests (avoids the global-pool audit race).

import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordConversationSkillLoadedParams extends RecorderBase {
  conversation_id: string;
  skill_id: string;
  skill_slug: string;
  skill_title: string;
  /** True when the skill was already in the palette and this call only
   *  refreshed its recency (re-promote); false on first load. */
  already_loaded: boolean;
}

export async function recordConversationSkillLoaded(
  p: RecordConversationSkillLoadedParams,
): Promise<RecordedEntry> {
  return auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: resolveActorType(p),
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_SKILL_LOADED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      reason: p.already_loaded ? "skill_re_promoted" : "skill_loaded",
      metadata: {
        skill_id: p.skill_id,
        skill_slug: p.skill_slug,
        skill_title: p.skill_title,
        already_loaded: p.already_loaded,
      },
    },
    p.executor,
  );
}
