import { describe, expect, test } from "bun:test";
import {
  applyOutcome,
  classifyOutcome,
  discard,
  due,
  enqueue,
  expireOld,
  OFFLINE_QUEUE_MAX_AGE_MS,
  OFFLINE_QUEUE_MAX_ITEMS,
  OFFLINE_RETRY_MAX_MS,
  type OfflineItem,
  releaseAuthHeld,
  retryDelayMs,
  retryFailed,
  summarize,
} from "./offline-queue.ts";

const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const me = { server: "https://subkit.example", user_id: "u-1" };
const other = { server: "https://subkit.example", user_id: "u-2" };

type Report = { message: string };

function queued(ids: string[], identity = me, at = NOW): OfflineItem<Report>[] {
  let queue: readonly OfflineItem<Report>[] = [];
  for (const id of ids) {
    const result = enqueue(
      queue,
      { id, kind: "feedback", payload: { message: id }, ...identity },
      at,
    );
    if (!result.ok) throw new Error(result.reason);
    queue = result.queue;
  }
  return [...queue];
}

describe("the offline queue for feedback", () => {
  test("a report written offline keeps its device time and is due at once", () => {
    const [item] = queued(["a"]);
    expect(item).toMatchObject({
      id: "a",
      created_on_device_at: "2026-11-21T10:00:00.000Z",
      attempts: 0,
      state: "waiting",
    });
    expect(due(queued(["a"]), { ...me, now: NOW })?.id).toBe("a");
  });

  test("the same id is queued only once, so a retry never files twice", () => {
    const queue = queued(["a"]);
    const again = enqueue(
      queue,
      { id: "a", kind: "feedback", payload: { message: "x" }, ...me },
      NOW,
    );
    expect(again.ok && again.queue).toEqual(queue);
  });

  test("a full queue refuses another report", () => {
    const ids = Array.from({ length: OFFLINE_QUEUE_MAX_ITEMS }, (_, i) => `r${i}`);
    const full = queued(ids);
    expect(
      enqueue(full, { id: "x", kind: "feedback", payload: { message: "x" }, ...me }, NOW),
    ).toEqual({
      ok: false,
      reason: "queue_full",
    });
  });

  test("one item at a time, the oldest first, and only for the identity signed in now", () => {
    const queue = [...queued(["first"], me, NOW - 2_000), ...queued(["second"], me, NOW - 1_000)];
    expect(due(queue, { ...me, now: NOW })?.id).toBe("first");
    expect(due(queue, { ...other, now: NOW })).toBeNull();
    expect(due(queue, { server: "https://other.example", user_id: "u-1", now: NOW })).toBeNull();
  });

  test("HTTP answers map onto what happens next", () => {
    expect(classifyOutcome({ status: 201 })).toEqual({ kind: "delivered" });
    expect(classifyOutcome(null)).toEqual({ kind: "retry" });
    expect(classifyOutcome({ status: 503 })).toEqual({ kind: "retry" });
    expect(classifyOutcome({ status: 429, retry_after_seconds: 120 })).toEqual({
      kind: "wait",
      seconds: 120,
    });
    expect(classifyOutcome({ status: 401 })).toEqual({ kind: "sign_in" });
    expect(classifyOutcome({ status: 403 })).toEqual({ kind: "sign_in" });
    expect(classifyOutcome({ status: 409 })).toEqual({ kind: "failed", failure: "conflict" });
    expect(classifyOutcome({ status: 413 })).toEqual({ kind: "failed", failure: "too_large" });
    expect(classifyOutcome({ status: 422 })).toEqual({ kind: "failed", failure: "refused" });
  });

  test("backoff doubles from 30 s up to 30 min, jitter takes off at most half", () => {
    expect(retryDelayMs(1, 1)).toBe(30_000);
    expect(retryDelayMs(2, 1)).toBe(60_000);
    expect(retryDelayMs(3, 0)).toBe(60_000);
    expect(retryDelayMs(20, 1)).toBe(OFFLINE_RETRY_MAX_MS);
  });

  test("delivered items leave, network errors wait, 429 waits as told", () => {
    const queue = queued(["a", "b"]);
    expect(applyOutcome(queue, "a", { kind: "delivered" }, NOW, 1).map((i) => i.id)).toEqual(["b"]);
    const retried = applyOutcome(queue, "a", { kind: "retry" }, NOW, 1);
    expect(retried[0]).toMatchObject({
      attempts: 1,
      next_attempt_at: NOW + 30_000,
      state: "waiting",
    });
    expect(due(retried, { ...me, now: NOW })?.id).toBe("b");
    const told = applyOutcome(queue, "a", { kind: "wait", seconds: 90 }, NOW, 1);
    expect(told[0]?.next_attempt_at).toBe(NOW + 90_000);
  });

  test("a lost session holds items until the same person signs in again", () => {
    const held = applyOutcome(queued(["a"]), "a", { kind: "sign_in" }, NOW, 1);
    expect(held[0]?.state).toBe("held_auth");
    expect(due(held, { ...me, now: NOW + 60_000 })).toBeNull();
    expect(releaseAuthHeld(held, other, NOW)[0]?.state).toBe("held_auth");
    const released = releaseAuthHeld(held, me, NOW + 60_000);
    expect(due(released, { ...me, now: NOW + 60_000 })?.id).toBe("a");
  });

  test("refused items fail for good until the person retries or discards them", () => {
    const failed = applyOutcome(queued(["a"]), "a", { kind: "failed", failure: "refused" }, NOW, 1);
    expect(failed[0]).toMatchObject({ state: "failed", failure: "refused" });
    expect(due(failed, { ...me, now: NOW + OFFLINE_RETRY_MAX_MS })).toBeNull();
    expect(retryFailed(failed, "a", NOW)[0]).toMatchObject({ state: "waiting", failure: null });
    expect(discard(failed, "a")).toEqual([]);
  });

  test("items older than 14 days expire and are never sent", () => {
    const old = queued(["a"], me, NOW - OFFLINE_QUEUE_MAX_AGE_MS - 1);
    expect(due(old, { ...me, now: NOW })).toBeNull();
    const expired = expireOld(old, NOW);
    expect(expired[0]).toMatchObject({ state: "failed", failure: "expired" });
    expect(retryFailed(expired, "a", NOW)[0]?.state).toBe("failed");
  });

  test("the summary counts per identity", () => {
    const queue = [
      ...queued(["a", "b"]),
      ...applyOutcome(queued(["c"]), "c", { kind: "sign_in" }, NOW, 1),
      ...queued(["d"], other),
    ];
    expect(summarize(queue, me)).toEqual({
      waiting: 2,
      held_auth: 1,
      failed: 0,
      next_attempt_at: NOW,
    });
  });
});
