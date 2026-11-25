import { type TransitionTable, transitionSourcesIn } from "@shared/transition-table.ts";

export type PatchCandidateStatus =
  | "proposed"
  | "applied"
  | "rejected"
  | "superseded"
  | "inapplicable";

export const PATCH_CANDIDATE_TRANSITIONS: TransitionTable<PatchCandidateStatus> = {
  proposed: ["applied", "rejected", "superseded", "inapplicable"],
  applied: [],
  rejected: [],
  superseded: [],
  inapplicable: [],
};

export function patchCandidateSources(to: PatchCandidateStatus): PatchCandidateStatus[] {
  return transitionSourcesIn(PATCH_CANDIDATE_TRANSITIONS, to);
}
