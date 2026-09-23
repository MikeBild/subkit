// A turn that died must not read as a turn that is thinking.
//
// A provider answered "You have reached your specified API usage limits. You
// will regain access on 2026-10-01 at 00:00 UTC." The engine logged it, wrote
// an `llm_usage` row, and rethrew. Nothing reached the conversation: status
// stayed `active`, no message was appended, and the transcript read "in
// progress". Twenty minutes went into diagnosing a hang that was not one —
// the sentence that settled it existed the whole time, in a log nobody reads
// while looking at a chat.

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
  // Committed and abandoned are decisions a person made; a stale error from
  // some earlier turn must not overwrite them.
  for (const status of ["committed", "abandoned"] as const) {
    expect(deriveConversationOutcome({ ...base, status, last_turn_error: QUOTA })).toBe(status);
  }
});

test("a pending question outranks a past failure", () => {
  // `awaiting_you` is the more actionable of the two: there is something the
  // reader can do right now, and answering it starts a fresh turn anyway.
  expect(
    deriveConversationOutcome({ ...base, status: "awaiting_input", last_turn_error: QUOTA }),
  ).toBe("awaiting_you");
});

test("no failure recorded changes nothing at all", () => {
  // The projection is computed at read time over existing rows; adding a
  // column must not move any answer that did not have one.
  const answered = { ...base, last_message_role: "assistant" };
  expect(deriveConversationOutcome(answered)).toBe("answered");
  expect(deriveConversationOutcome({ ...answered, last_turn_error: null })).toBe("answered");
  expect(deriveConversationOutcome({ ...answered, last_turn_error: undefined })).toBe("answered");
});

test("an answered turn after a failure is answered again", () => {
  // The recorder is cleared when the next turn starts, so this is what a
  // successful retry looks like: no error, assistant last.
  expect(
    deriveConversationOutcome({
      ...base,
      last_message_role: "assistant",
      last_turn_error: null,
    }),
  ).toBe("answered");
});
