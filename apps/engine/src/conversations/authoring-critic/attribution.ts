import type { CriticRunResult } from "./critic-agent.ts";

export interface CriticReviewRecord {
  result: CriticRunResult;
  gating_reason: string;
  pass: number;
}

export type AuthoringCriticReport =
  | {
      result: CriticRunResult;
      gating_reason: string;
      reviewed_pass: number;
      returned_pass: number;
      reviewed_returned_definition: boolean;
    }
  | {
      result: "not_reached";
      reason: "static_findings" | "deadline_exceeded" | "no_definition";
      returned_pass: number | null;
    };

export interface CandidateSwap {
  returned_pass: number;
  latest_pass: number;
  reason: "latest_candidate_invalid";
}

export function attributeCriticReview(input: {
  review: CriticReviewRecord | null;
  returnedPass: number | null;
  deadlineExceeded: boolean;
}): AuthoringCriticReport {
  if (input.review && input.returnedPass !== null) {
    return {
      result: input.review.result,
      gating_reason: input.review.gating_reason,
      reviewed_pass: input.review.pass,
      returned_pass: input.returnedPass,
      reviewed_returned_definition: input.review.pass === input.returnedPass,
    };
  }
  return {
    result: "not_reached",
    reason:
      input.returnedPass === null
        ? "no_definition"
        : input.deadlineExceeded
          ? "deadline_exceeded"
          : "static_findings",
    returned_pass: input.returnedPass,
  };
}
