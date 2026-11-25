import type { WorkflowAuthorityPreview } from "./workflow-authorities";

export type TrialPhase =
  | { kind: "idle"; asked: boolean; skipped: boolean; elsewhere: boolean }
  | { kind: "running"; asked: boolean; startedAt: number };

export interface AuthorityReviewFlow {
  review: WorkflowAuthorityPreview | null;
  decision: WorkflowAuthorityPreview | null;
  trial: TrialPhase;
}

export type AuthorityReviewEvent =
  | { type: "review_started"; pinned: boolean; trial: boolean }
  | { type: "trial_started"; at: number }
  | { type: "trial_finished"; elsewhere?: boolean }
  | {
      type: "review_answered";
      decision: WorkflowAuthorityPreview;
      review: WorkflowAuthorityPreview | null;
      skipped: boolean;
    }
  | { type: "left" };

export const initialAuthorityReview: AuthorityReviewFlow = {
  review: null,
  decision: null,
  trial: { kind: "idle", asked: false, skipped: false, elsewhere: false },
};

function stopTrial(trial: TrialPhase, elsewhere?: boolean): TrialPhase {
  if (trial.kind === "idle") return elsewhere === undefined ? trial : { ...trial, elsewhere };
  return { kind: "idle", asked: trial.asked, skipped: false, elsewhere: elsewhere ?? false };
}

export function authorityReviewReducer(
  state: AuthorityReviewFlow,
  event: AuthorityReviewEvent,
): AuthorityReviewFlow {
  switch (event.type) {
    case "review_started":
      return {
        review: null,
        decision: event.pinned ? state.decision : null,
        trial: { kind: "idle", asked: event.trial, skipped: false, elsewhere: false },
      };
    case "trial_started":
      return {
        ...state,
        trial: { kind: "running", asked: state.trial.asked, startedAt: event.at },
      };
    case "trial_finished":
      return { ...state, trial: stopTrial(state.trial, event.elsewhere) };
    case "review_answered": {
      const trial = stopTrial(state.trial);
      return {
        review: event.review ?? state.review,
        decision: event.decision,
        trial: trial.kind === "idle" ? { ...trial, skipped: event.skipped } : trial,
      };
    }
    case "left":
      return { ...state, review: null, decision: null, trial: stopTrial(state.trial) };
  }
}

export function trialElapsedSeconds(trial: TrialPhase, now: number): number {
  return trial.kind === "running" ? Math.max(0, Math.floor((now - trial.startedAt) / 1000)) : 0;
}
