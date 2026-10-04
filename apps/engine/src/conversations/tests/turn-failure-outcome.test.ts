import { expect, test } from "bun:test";
import { deriveConversationOutcome } from "../lifecycle-view.ts";

const QUOTA = {
  code: "internal",
  message:
    "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.",
  at: "2026-09-23T06:30:10.000Z",
};
const base = {
  status: "active",
  last_message_role: "user" as string | null,
  last_activity_at: "2026-09-23T06:30:04.000Z",
  now: Date.parse("2026-09-23T07:00:00.000Z"),
};

test("a recorded failure is reported as failed, not as in progress", () => {
  expect(deriveConversationOutcome(base)).toBe("in_progress");
  expect(deriveConversationOutcome({ ...base, last_turn_error: QUOTA })).toBe("failed");
});

test("a decided conversation keeps its own state", () => {
  for (const status of ["committed", "abandoned"] as const) {
    expect(deriveConversationOutcome({ ...base, status, last_turn_error: QUOTA })).toBe(status);
  }
});

test("a pending question outranks a past failure", () => {
  expect(
    deriveConversationOutcome({ ...base, status: "awaiting_input", last_turn_error: QUOTA }),
  ).toBe("awaiting_you");
});

test("no failure recorded changes nothing at all", () => {
  const answered = { ...base, last_message_role: "assistant" };
  expect(deriveConversationOutcome(answered)).toBe("answered");
  expect(deriveConversationOutcome({ ...answered, last_turn_error: null })).toBe("answered");
  expect(deriveConversationOutcome({ ...answered, last_turn_error: undefined })).toBe("answered");
});

test("an answered turn after a failure is answered again", () => {
  expect(
    deriveConversationOutcome({
      ...base,
      last_message_role: "assistant",
      last_turn_error: null,
    }),
  ).toBe("answered");
});
