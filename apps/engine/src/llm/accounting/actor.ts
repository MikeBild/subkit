import type { AuditActorType } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";

export interface ActorFields {
  user_id: string | null;
  actor_type: AuditActorType;
}

export function actorFields(principal?: ResolvedPrincipal | null): ActorFields {
  if (!principal) return { user_id: null, actor_type: "system" };
  return principal.kind === "user"
    ? { user_id: principal.id, actor_type: "user" }
    : { user_id: principal.id, actor_type: "system_account" };
}
