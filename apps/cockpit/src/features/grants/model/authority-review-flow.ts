import type { WorkflowAuthorityPreview } from "./workflow-authorities";

/**
 * The authority review dialog: which preview is under review, which one decides the
 * approval choice, and whether a trial run is preparing it right now.
 */
export type TrialPhase =
  | { kind: "idle"; asked: boolean; skipped: boolean; elsewhere: boolean }
  | { kind: "running"; asked: boolean; startedAt: number };

export interface AuthorityReviewFlow {
  review: WorkflowAuthorityPreview | null;
  decision: WorkflowAuthorityPreview | null;
  trial: TrialPhase;
}

export type AuthorityReviewEvent =
  /** A new review starts; a trial is `asked` when the person chose "try it first". */
  | { type: "review_started"; pinned: boolean; trial: boolean }
  /** The engine started a trial run to prepare the review. */
  | { type: "trial_started"; at: number }
  /** The trial run ended; `elsewhere` is known only when the engine answered. */
  | { type: "trial_finished"; elsewhere?: boolean }
  /** The review answer arrived. Without a `review` the previous one stays. */
  | {
      type: "review_answered";
      decision: WorkflowAuthorityPreview;
      review: WorkflowAuthorityPreview | null;
      skipped: boolean;
    }
  /** The dialog closed. */
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

/** Whole seconds the running trial has taken at `now`; 0 when no trial runs. */
export function trialElapsedSeconds(trial: TrialPhase, now: number): number {
  return trial.kind === "running" ? Math.max(0, Math.floor((now - trial.startedAt) / 1000)) : 0;
}
