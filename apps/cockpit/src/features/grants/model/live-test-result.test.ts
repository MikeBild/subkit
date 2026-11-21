import { expect, test } from "bun:test";
import { liveTestState } from "@/features/grants/model/live-test-result";

test("only an explicit live test result produces a test status", () => {
  expect(liveTestState({ execution_authorized: true })).toBeNull();
  expect(liveTestState({ live_test: { state: "not_requested" } })).toBeNull();
  expect(liveTestState({ live_test: { state: "running" } })).toBe("running");
  expect(liveTestState({ live_test: { state: "queued" } })).toBe("pending");
  expect(liveTestState({ live_test: { state: "failed" } })).toBe("failed");
  expect(liveTestState({ live_test: { state: "blocked" } })).toBe("blocked");
  expect(liveTestState({ live_test: { state: "succeeded" } })).toBe("succeeded");
  expect(liveTestState(null)).toBeNull();
});
