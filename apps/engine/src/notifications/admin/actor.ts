import type { ResolvedPrincipal } from "../../auth/types.ts";

export type NotificationActor = Pick<ResolvedPrincipal, "tenant_id" | "kind" | "id">;

export function auditedBy(actor: NotificationActor) {
  return {
    tenant_id: actor.tenant_id,
    actor_type: actor.kind,
    actor_id: actor.id,
  };
}
