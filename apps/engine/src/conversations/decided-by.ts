import type { Actor } from "../audit/actor.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";

export type DecidedBy = Actor;

export function decidedByFor(
  actor_id: string | null,
  principal: Pick<ResolvedPrincipal, "id" | "kind"> | null | undefined,
): DecidedBy | null {
  if (!actor_id) return null;
  if (principal?.id === actor_id) return { id: actor_id, kind: principal.kind };
  return { id: actor_id, kind: "user" };
}
