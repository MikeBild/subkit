import { auditAwait } from "../audit.ts";
import { AuditAction } from "../types.ts";
import { type RecordedEntry, type RecorderBase, resolveActorType } from "./types.ts";

export interface RecordConversationSkillLoadedParams extends RecorderBase {
  conversation_id: string;
  skill_id: string;
  skill_slug: string;
  skill_title: string;
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
