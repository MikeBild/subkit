import { type TransitionTable, transitionSourcesIn } from "@shared/transition-table.ts";

export type ElicitationStatus = "pending" | "resolved" | "cancelled" | "timeout";

export const ELICITATION_TRANSITIONS: TransitionTable<ElicitationStatus> = {
  pending: ["resolved", "cancelled", "timeout"],
  resolved: [],
  cancelled: [],
  timeout: [],
};

export function elicitationSources(to: ElicitationStatus): ElicitationStatus[] {
  return transitionSourcesIn(ELICITATION_TRANSITIONS, to);
}
