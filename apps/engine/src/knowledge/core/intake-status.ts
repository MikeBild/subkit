import {
  canTransitionIn,
  type TransitionTable,
  transitionSourcesIn,
} from "@shared/transition-table.ts";
import type { IntakeItemState, IntakeProposalStatus } from "../intake-types.ts";

export const INTAKE_PROPOSAL_TRANSITIONS: TransitionTable<IntakeProposalStatus> = {
  draft: ["draft", "stale", "confirmed", "rejected"],
  stale: ["draft"],
  confirmed: [],
  rejected: [],
};

export const INTAKE_ITEM_TRANSITIONS: TransitionTable<IntakeItemState> = {
  collected: ["collected", "reviewing", "admitted", "discarded"],
  reviewing: ["collected", "reviewing", "admitted", "discarded"],
  discarded: ["collected", "reviewing", "discarded"],
  admitted: ["admitted"],
};

export function intakeProposalSources(to: IntakeProposalStatus): IntakeProposalStatus[] {
  return transitionSourcesIn(INTAKE_PROPOSAL_TRANSITIONS, to);
}

export function intakeItemSources(to: IntakeItemState): IntakeItemState[] {
  return transitionSourcesIn(INTAKE_ITEM_TRANSITIONS, to);
}

export function canMoveIntakeItem(from: IntakeItemState, to: IntakeItemState): boolean {
  return canTransitionIn(INTAKE_ITEM_TRANSITIONS, from, to);
}
