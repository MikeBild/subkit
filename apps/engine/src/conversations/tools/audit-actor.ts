import type { Actor } from "../../audit/actor.ts";
import type { ToolContext } from "./index.ts";

export function auditActorFromToolContext(ctx: ToolContext): {
  actor_type: "user" | "system_account" | "system" | "unknown";
  actor_id: string | null;
} {
  if (ctx.principal) {
    return { actor_type: ctx.principal.kind, actor_id: ctx.principal.id };
  }
  const actor = ctx.engineClient?.context;
  if (actor?.actor_type) {
    return { actor_type: actor.actor_type, actor_id: actor.actor_id };
  }
  if (ctx.actor_id) return { actor_type: "unknown", actor_id: null };
  return { actor_type: "system", actor_id: null };
}

export function connectorActorFromToolContext(
  ctx: ToolContext,
): Actor | { kind: "unknown" } | null {
  if (ctx.principal) return { kind: ctx.principal.kind, id: ctx.principal.id };
  const actor = ctx.engineClient?.context;
  if ((actor?.actor_type === "user" || actor?.actor_type === "system_account") && actor.actor_id) {
    return { kind: actor.actor_type, id: actor.actor_id };
  }
  if (actor?.actor_type === "unknown" || (actor?.actor_type == null && ctx.actor_id)) {
    return { kind: "unknown" };
  }
  return null;
}
