import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/transport";
import type { FeedbackBody } from "./model";
import { createFeedbackQueue, type FeedbackQueueItem } from "./offline";
import { memoryQueueStore } from "./queue-store";

const anna = { server: "https://subkit.example", user_id: "anna" };
const bert = { server: "https://subkit.example", user_id: "bert" };
const body = (message: string): FeedbackBody => ({ kind: "bug", message });

function harness(answers: Array<"ok" | "offline" | number>) {
  let clock = Date.parse("2026-11-21T10:00:00.000Z");
  const sent: FeedbackBody[] = [];
  const store = memoryQueueStore<FeedbackQueueItem>();
  const queue = createFeedbackQueue({
    store,
    now: () => clock,
    jitter: () => 1,
    send: async (payload) => {
      sent.push(payload);
      const answer = answers.shift() ?? "ok";
      if (answer === "offline") throw new TypeError("Failed to fetch");
      if (typeof answer === "number")
        throw new ApiError(answer, { details: { retry_after_seconds: 90 } }, null);
      return { id: "f", intake_item_id: "i", replayed: false };
    },
  });
  return {
    queue,
    store,
    sent,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("offline feedback queue", () => {
  test("queued reports go out one at a time with their id and device time", async () => {
    const h = harness(["ok", "ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    h.tick(1_000);
    await h.queue.add(anna, "id-2", body("two"));
    expect(await h.queue.waiting(anna)).toBe(2);
    await h.queue.flush(anna);
    expect(h.sent).toEqual([
      {
        kind: "bug",
        message: "one",
        client_request_id: "id-1",
        created_on_device_at: "2026-11-21T10:00:00.000Z",
      },
      {
        kind: "bug",
        message: "two",
        client_request_id: "id-2",
        created_on_device_at: "2026-11-21T10:00:01.000Z",
      },
    ]);
    expect(await h.queue.waiting(anna)).toBe(0);
  });

  test("still offline: the report stays and the next attempt backs off", async () => {
    const h = harness(["offline", "ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    await h.queue.flush(anna);
    expect(await h.queue.waiting(anna)).toBe(1);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(1);
    h.tick(30_000);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(2);
    expect(await h.queue.waiting(anna)).toBe(0);
  });

  test("a rate limit waits as long as the server says", async () => {
    const h = harness([429, "ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    await h.queue.flush(anna);
    h.tick(60_000);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(1);
    h.tick(30_000);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(2);
  });

  test("a sign-in refusal holds the report until the next sign-in", async () => {
    const h = harness([401, "ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    await h.queue.flush(anna);
    h.tick(3_600_000);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(1);
    expect(await h.queue.waiting(anna)).toBe(1);
    await h.queue.signedIn(anna);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(2);
  });

  test("a report is only ever sent for the person who wrote it", async () => {
    const h = harness(["ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    await h.queue.flush(bert);
    expect(h.sent).toHaveLength(0);
    expect(await h.queue.waiting(bert)).toBe(0);
  });

  test("parallel triggers share one send", async () => {
    const h = harness(["ok"]);
    await h.queue.add(anna, "id-1", body("one"));
    await Promise.all([h.queue.flush(anna), h.queue.flush(anna)]);
    expect(h.sent).toHaveLength(1);
  });

  test("a permanent refusal stops retrying", async () => {
    const h = harness([422]);
    await h.queue.add(anna, "id-1", body("one"));
    await h.queue.flush(anna);
    h.tick(3_600_000);
    await h.queue.flush(anna);
    expect(h.sent).toHaveLength(1);
    expect(await h.queue.waiting(anna)).toBe(0);
    expect((await h.store.load())[0]?.state).toBe("failed");
  });

  test("a failed report is listed once and can be discarded", async () => {
    const h = harness([413]);
    await h.queue.add(anna, "id-1", body("zu groß"));
    await h.queue.flush(anna);
    expect(await h.queue.failed(anna)).toMatchObject([
      { id: "id-1", failure: "too_large", canResend: false },
    ]);
    expect(await h.queue.failed(bert)).toEqual([]);
    let changes = 0;
    h.queue.subscribe(() => {
      changes += 1;
    });
    await h.queue.discard(anna, "id-1");
    expect(await h.queue.failed(anna)).toEqual([]);
    expect(await h.store.load()).toEqual([]);
    expect(changes).toBe(1);
  });

  test("a taken report id is sent again under a new id", async () => {
    const h = harness([409, "ok"]);
    await h.queue.add(anna, "id-1", body("eins"));
    await h.queue.flush(anna);
    expect(await h.queue.failed(anna)).toMatchObject([{ failure: "conflict", canResend: true }]);
    await h.queue.resend(anna, "id-1", "id-2");
    expect(h.sent.map((payload) => payload.client_request_id)).toEqual(["id-1", "id-2"]);
    expect(await h.queue.failed(anna)).toEqual([]);
    expect(await h.store.load()).toEqual([]);
  });
});
