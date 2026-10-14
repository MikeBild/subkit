import { type Actor, actorOf } from "../../audit/actor.ts";
import type { ToolContext } from "./index.ts";

export function toolActor(ctx: Pick<ToolContext, "principal" | "actor_id">): Actor | null {
  if (ctx.principal) return actorOf(ctx.principal);
  return null;
}
