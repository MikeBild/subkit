import type { AuditActorType } from "./types.ts";

export interface PrincipalLike {
  kind: "user" | "system_account";
}

export function actorType(principal: PrincipalLike): AuditActorType {
  return principal.kind === "user" ? "user" : "system_account";
}
