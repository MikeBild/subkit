import type { PrincipalKind } from "../auth/types.ts";
import type { KnownAuditActorType } from "./types.ts";

interface PrincipalLike {
  kind: "user" | "system_account";
}

export interface Actor {
  kind: PrincipalKind;
  id: string;
}

export function actorType(principal: PrincipalLike): KnownAuditActorType {
  return principal.kind === "user" ? "user" : "system_account";
}

export function actorOf(principal: { kind: PrincipalKind; id: string }): Actor {
  return { kind: principal.kind, id: principal.id };
}

export function auditActor(actor: Actor | null): {
  actor_type: KnownAuditActorType;
  actor_id: string | null;
} {
  if (!actor) return { actor_type: "system", actor_id: null };
  return { actor_type: actorType(actor), actor_id: actor.id };
}

export function actorIds(actor: Actor | null): {
  user_id: string | null;
  system_account_id: string | null;
} {
  return {
    user_id: actor?.kind === "user" ? actor.id : null,
    system_account_id: actor?.kind === "system_account" ? actor.id : null,
  };
}

export function actorFromColumns(
  user_id: string | null,
  system_account_id: string | null,
): Actor | null {
  if (user_id) return { kind: "user", id: user_id };
  if (system_account_id) return { kind: "system_account", id: system_account_id };
  return null;
}
