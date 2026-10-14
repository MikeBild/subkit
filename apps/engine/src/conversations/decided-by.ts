import type { Actor } from "../audit/actor.ts";
import type { AuditActorType } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { AnswerActor } from "./answer-actor.ts";

export type DecidedBy = Actor | { kind: "unknown"; id: null };

export function decidedByFor(
  actor_id: string | null,
  tenant_id: string,
  principal: Pick<ResolvedPrincipal, "id" | "kind" | "tenant_id"> | null | undefined,
  answer_actor?: AnswerActor,
): DecidedBy | null {
  if (answer_actor?.kind === "human") {
    return { id: answer_actor.user_id, kind: "user" };
  }
  if (!actor_id) return null;
  if (principal?.tenant_id === tenant_id && principal.id === actor_id) {
    return { id: actor_id, kind: principal.kind };
  }
  return { id: null, kind: "unknown" };
}

export function decidedByAuditActor(decided_by: DecidedBy | null): {
  actor_type: AuditActorType;
  actor_id: string | null;
} {
  if (decided_by?.kind === "unknown") return { actor_type: "unknown", actor_id: null };
  if (!decided_by) return { actor_type: "system", actor_id: null };
  return { actor_type: decided_by.kind, actor_id: decided_by.id };
}
