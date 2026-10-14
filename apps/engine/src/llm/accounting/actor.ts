import type { KnownAuditActorType } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";

export interface ActorFields {
  user_id: string | null;
  actor_type: KnownAuditActorType;
}

export type EngineClientActorType = KnownAuditActorType | "unknown";

export function actorFields(principal?: ResolvedPrincipal | null): ActorFields {
  if (!principal) return { user_id: null, actor_type: "system" };
  return principal.kind === "user"
    ? { user_id: principal.id, actor_type: "user" }
    : { user_id: principal.id, actor_type: "system_account" };
}

export function engineClientActorType(
  principal: ResolvedPrincipal | null | undefined,
  actor_id: string | null,
): EngineClientActorType {
  if (principal) return actorFields(principal).actor_type;
  return actor_id === null ? "system" : "unknown";
}
