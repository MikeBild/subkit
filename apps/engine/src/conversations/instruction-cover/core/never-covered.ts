import type { BoundAction } from "../bound-action.ts";

export function isNeverCovered(action: Pick<BoundAction, "effect_class" | "verbs">): boolean {
  return action.effect_class !== "ordinary" || action.verbs.length === 0;
}
