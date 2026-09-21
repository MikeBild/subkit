import { expect, test } from "bun:test";
import { abstentionDecision } from "./abstention-gate.ts";

test("a failed verdict interrupts the human when nothing else is being asked", () => {
  expect(
    abstentionDecision({
      commitAbstains: false,
      faithfulnessAbstains: true,
      hasPendingQuestion: false,
    }),
  ).toBe("raise");
  expect(
    abstentionDecision({
      commitAbstains: true,
      faithfulnessAbstains: false,
      hasPendingQuestion: false,
    }),
  ).toBe("raise");
});

test("a verdict never cancels a question the human is already being asked", () => {
  // Raising would supersede the pending question; the verdict stays a logged note.
  for (const verdict of [
    { commitAbstains: true, faithfulnessAbstains: false },
    { commitAbstains: false, faithfulnessAbstains: true },
    { commitAbstains: true, faithfulnessAbstains: true },
  ])
    expect(abstentionDecision({ ...verdict, hasPendingQuestion: true })).toBe(
      "skip_pending_question",
    );
});

test("no failed verdict means nothing to decide, pending question or not", () => {
  for (const hasPendingQuestion of [true, false])
    expect(
      abstentionDecision({
        commitAbstains: false,
        faithfulnessAbstains: false,
        hasPendingQuestion,
      }),
    ).toBe("none");
});
