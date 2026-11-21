import { describe, expect, test } from "bun:test";
import type { OfflineFailure } from "@shared/offline-queue.ts";
import {
  canResend,
  discardFailed,
  excerptOf,
  FAILED_EXCERPT_MAX,
  failedReports,
  resendFailed,
} from "./failed-model";
import type { FeedbackQueueItem } from "./offline";

const anna = { server: "https://subkit.example", user_id: "anna" };
const bert = { server: "https://subkit.example", user_id: "bert" };
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

const item = (over: Partial<FeedbackQueueItem> = {}): FeedbackQueueItem => ({
  id: "r1",
  kind: "feedback",
  ...anna,
  created_on_device_at: "2026-11-20T10:00:00.000Z",
  payload: { kind: "bug", message: "Export bricht ab", client_request_id: "r1" },
  attempts: 2,
  next_attempt_at: 0,
  state: "failed",
  failure: "conflict",
  ...over,
});

describe("which failures can be sent again", () => {
  test("only a taken report id can succeed under a new id", () => {
    const allowed: Record<OfflineFailure, boolean> = {
      conflict: true,
      refused: false,
      too_large: false,
      expired: false,
    };
    for (const [failure, expected] of Object.entries(allowed))
      expect(canResend(failure as OfflineFailure)).toBe(expected);
  });
});

describe("excerpt", () => {
  test("first line, trimmed", () => {
    expect(excerptOf("  Export bricht ab\nDetails folgen")).toBe("Export bricht ab");
  });

  test("long lines end with an ellipsis within the limit", () => {
    const out = excerptOf("x".repeat(200));
    expect(out).toHaveLength(FAILED_EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("failed reports", () => {
  test("lists only my failed reports, newest first", () => {
    const queue = [
      item({ id: "old", created_on_device_at: "2026-11-01T10:00:00.000Z", failure: "expired" }),
      item({ id: "new", created_on_device_at: "2026-11-20T10:00:00.000Z", failure: "too_large" }),
      item({ id: "waiting", state: "waiting", failure: null }),
      item({ id: "theirs", ...bert }),
    ];
    expect(failedReports(queue, anna)).toEqual([
      {
        id: "new",
        failure: "too_large",
        excerpt: "Export bricht ab",
        created_on_device_at: "2026-11-20T10:00:00.000Z",
        canResend: false,
      },
      {
        id: "old",
        failure: "expired",
        excerpt: "Export bricht ab",
        created_on_device_at: "2026-11-01T10:00:00.000Z",
        canResend: false,
      },
    ]);
  });

  test("nothing failed means an empty list", () => {
    expect(failedReports([item({ state: "waiting", failure: null })], anna)).toEqual([]);
  });
});

describe("send again", () => {
  test("a taken id goes back into the queue under a new id, ready now", () => {
    const [next] = resendFailed([item()], anna, "r1", "r1-b", NOW);
    expect(next).toMatchObject({
      id: "r1-b",
      payload: { client_request_id: "r1-b", message: "Export bricht ab" },
      state: "waiting",
      failure: null,
      attempts: 0,
      next_attempt_at: NOW,
      created_on_device_at: "2026-11-20T10:00:00.000Z",
    });
  });

  test("other reasons, other people and waiting reports stay as they are", () => {
    const queue = [
      item({ id: "large", failure: "too_large" }),
      item({ id: "theirs", ...bert }),
      item({ id: "waiting", state: "waiting", failure: null }),
    ];
    for (const entry of queue)
      expect(resendFailed(queue, anna, entry.id, "new", NOW)).toEqual(queue);
  });
});

describe("discard", () => {
  test("removes only my failed report", () => {
    const queue = [item(), item({ id: "theirs", ...bert }), item({ id: "w", state: "waiting" })];
    expect(discardFailed(queue, anna, "r1").map((entry) => entry.id)).toEqual(["theirs", "w"]);
    expect(discardFailed(queue, anna, "theirs")).toEqual(queue);
    expect(discardFailed(queue, anna, "w")).toEqual(queue);
  });
});
