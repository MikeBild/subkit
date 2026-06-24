// Derive the LLM-usage attribution fields from a resolved principal.
//
// Mirrors the EngineClient constructor + audit-log default: a user
// principal attributes to its id with actor_type 'user'; a system_account
// attributes its id with actor_type 'system_account'; an absent principal
// (scheduled / queue / proactive self-healing) is the tenant-only
// 'system' row exactly as before this feature.

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
