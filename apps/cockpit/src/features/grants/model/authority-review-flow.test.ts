import { describe, expect, test } from "bun:test";
import {
  type AuthorityReviewEvent,
  type AuthorityReviewFlow,
  authorityReviewReducer,
  initialAuthorityReview,
  trialElapsedSeconds,
} from "./authority-review-flow";
import type { WorkflowAuthorityPreview } from "./workflow-authorities";

const preview = (digest: string) => ({ digest }) as unknown as WorkflowAuthorityPreview;
const run = (events: AuthorityReviewEvent[], from: AuthorityReviewFlow = initialAuthorityReview) =>
  events.reduce(authorityReviewReducer, from);

describe("authority review flow", () => {
  test("starting a review clears the review and, unless pinned, the decision", () => {
    const answered = run([
      { type: "review_started", pinned: false, trial: false },
      { type: "review_answered", decision: preview("d1"), review: preview("r1"), skipped: false },
    ]);
    expect(run([{ type: "review_started", pinned: true, trial: false }], answered)).toMatchObject({
      review: null,
      decision: preview("d1"),
    });
    expect(run([{ type: "review_started", pinned: false, trial: false }], answered)).toMatchObject({
      review: null,
      decision: null,
    });
  });

  test("a trial runs between start and finish and remembers that it was asked for", () => {
    const running = run([
      { type: "review_started", pinned: true, trial: true },
      { type: "trial_started", at: 1_000 },
    ]);
    expect(running.trial).toEqual({ kind: "running", asked: true, startedAt: 1_000 });
    expect(trialElapsedSeconds(running.trial, 4_500)).toBe(3);
    const finished = run([{ type: "trial_finished", elsewhere: true }], running);
    expect(finished.trial).toEqual({ kind: "idle", asked: true, skipped: false, elsewhere: true });
    expect(trialElapsedSeconds(finished.trial, 9_000)).toBe(0);
  });

  test("a trial that failed before the engine answered is not reported as running elsewhere", () => {
    const failed = run([
      { type: "review_started", pinned: true, trial: false },
      { type: "trial_started", at: 0 },
      { type: "trial_finished" },
    ]);
    expect(failed.trial).toEqual({ kind: "idle", asked: false, skipped: false, elsewhere: false });
  });

  test("the answer sets the decision, keeps the earlier review when it brings none, and marks a skipped trial", () => {
    const withReview = run([
      { type: "review_started", pinned: true, trial: true },
      { type: "review_answered", decision: preview("d1"), review: preview("r1"), skipped: false },
    ]);
    const sample = run(
      [{ type: "review_answered", decision: preview("d2"), review: null, skipped: true }],
      withReview,
    );
    expect(sample.review).toEqual(preview("r1"));
    expect(sample.decision).toEqual(preview("d2"));
    expect(sample.trial).toMatchObject({ kind: "idle", skipped: true });
  });

  test("leaving drops review, decision and a running trial but keeps the trial notes", () => {
    const left = run([
      { type: "review_started", pinned: true, trial: true },
      { type: "trial_finished", elsewhere: true },
      { type: "review_answered", decision: preview("d"), review: preview("r"), skipped: true },
      { type: "left" },
    ]);
    expect(left).toEqual({
      review: null,
      decision: null,
      trial: { kind: "idle", asked: true, skipped: true, elsewhere: true },
    });
  });
});
