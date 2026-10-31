import { expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import {
  workflowReviewBlockedKey,
  workflowReviewFailure,
  workflowReviewStorageKey,
} from "./workflow-review";

test("a save gate that blocks completion names its own explanation", () => {
  expect(workflowReviewBlockedKey(new ApiError(422, { code: "workflow_not_ready" }, null))).toBe(
    "reviewWorkflow.blocked.workflow_not_ready",
  );
  expect(workflowReviewBlockedKey(new ApiError(422, { code: "preview_failed" }, null))).toBe(
    "reviewWorkflow.blocked.preview_failed",
  );
  expect(workflowReviewBlockedKey(new ApiError(422, { code: "unknown_gate" }, null))).toBeNull();
  expect(
    workflowReviewBlockedKey(new ApiError(409, { code: "workflow_not_ready" }, null)),
  ).toBeNull();
});

test("ambiguous completion errors require checking the persisted result", () => {
  for (const error of [
    new TypeError("network"),
    new DOMException("timeout", "TimeoutError"),
    new ApiError(502, {}, null),
    new ApiError(408, {}, null),
  ]) {
    expect(workflowReviewFailure(error, true)).toBe("uncertain");
  }
  expect(workflowReviewFailure(new TypeError("network"), false)).toBe("failed");
});

test("a changed or expired receipt requires another review", () => {
  expect(workflowReviewFailure(new ApiError(409, {}, null), true)).toBe("stale");
  expect(workflowReviewFailure(new ApiError(410, {}, null), true)).toBe("expired");
  expect(workflowReviewFailure(new ApiError(422, {}, null), true)).toBe("blocked");
  expect(workflowReviewFailure(new ApiError(403, {}, null), true)).toBe("failed");
});

test("recovery is scoped to the conversation and its pending decision", () => {
  expect(workflowReviewStorageKey("a", "first")).not.toBe(workflowReviewStorageKey("b", "first"));
  expect(workflowReviewStorageKey("a", "first")).not.toBe(workflowReviewStorageKey("a", "second"));
});
