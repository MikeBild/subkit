import { describe, expect, test } from "bun:test";
import type { RunLoopResult } from "../conversations/loop/index.ts";
import { intakeReviewHandoff } from "./intake-handoff.ts";

const conversationId = "10000000-0000-4000-8000-000000000001";

function outcome(tool: string, output: unknown = {}): RunLoopResult {
  return {
    status: "active",
    events: [{ type: "tool_result", call_id: "call", tool, output }],
  };
}

describe("intakeReviewHandoff", () => {
  test("hands an actual intake review to the persisted Cockpit conversation", () => {
    expect(
      intakeReviewHandoff(
        outcome("get_intake_item", { item: {} }),
        conversationId,
        "https://subkit.example/",
      ),
    ).toBe(
      `Continue this review in SubKit: https://subkit.example/cockpit/chat/${conversationId}\nReview the exact proposal and confirm it before it becomes knowledge or a skill.`,
    );
  });

  test("does not add a handoff without an intake tool result", () => {
    expect(intakeReviewHandoff(outcome("search_knowledge"), conversationId, null)).toBeNull();
  });

  test("does not hand off a failed intake read", () => {
    expect(
      intakeReviewHandoff(outcome("get_intake_item", { error: "not_found" }), conversationId, null),
    ).toBeNull();
  });
});
