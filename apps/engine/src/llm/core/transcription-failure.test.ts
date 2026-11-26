import { describe, expect, test } from "bun:test";
import {
  attemptOutcome,
  neverSent,
  recordingFetch,
  type TranscriptionAttempt,
  TranscriptionDispatchError,
  type TranscriptionFailureOutcome,
  transcriptionFailureOutcome,
} from "./transcription-failure.ts";

const answered = (status: number): TranscriptionAttempt => ({ phase: "answered", status });
const failed = (...attempts: TranscriptionAttempt[]) =>
  new TranscriptionDispatchError(new Error("provider call failed"), attempts);
const coded = (code: string) => Object.assign(new TypeError(code), { code });

describe("transcription failure outcome", () => {
  test.each<[string, unknown, TranscriptionFailureOutcome]>([
    ["no request was dispatched", failed(), "release"],
    ["the connection was refused before sending", failed({ phase: "unsent" }), "release"],
    ["bad request", failed(answered(400)), "release"],
    ["key rejected", failed(answered(401)), "release"],
    ["forbidden", failed(answered(403)), "release"],
    ["payload too large", failed(answered(413)), "release"],
    ["unsupported media type", failed(answered(415)), "release"],
    ["unprocessable", failed(answered(422)), "release"],
    ["rate limited on every attempt", failed(answered(429), answered(429)), "release"],
    ["timeout or reset after sending", failed({ phase: "sent" }), "reconcile"],
    ["internal server error", failed(answered(500)), "reconcile"],
    ["service unavailable", failed(answered(503)), "reconcile"],
    ["malformed success answer", failed(answered(200)), "reconcile"],
    ["redirect answer", failed(answered(399)), "reconcile"],
    ["rejection after an ambiguous attempt", failed(answered(502), answered(429)), "reconcile"],
    ["error without dispatch facts", new Error("HTTP 400"), "reconcile"],
    ["thrown non-error", "boom", "reconcile"],
  ])("%s -> %s", (_, error, outcome) => {
    expect(transcriptionFailureOutcome(error)).toBe(outcome);
  });

  test.each<[TranscriptionAttempt, TranscriptionFailureOutcome]>([
    [{ phase: "unsent" }, "release"],
    [{ phase: "sent" }, "reconcile"],
    [answered(499), "release"],
    [answered(500), "reconcile"],
  ])("attempt %p -> %s", (attempt, outcome) => {
    expect(attemptOutcome(attempt)).toBe(outcome);
  });

  test.each<[unknown, boolean]>([
    [coded("ECONNREFUSED"), true],
    [coded("ENOTFOUND"), true],
    [coded("EAI_AGAIN"), true],
    [coded("ConnectionRefused"), true],
    [new TypeError("fetch failed", { cause: coded("ECONNREFUSED") }), true],
    [coded("ECONNRESET"), false],
    [new DOMException("timeout", "TimeoutError"), false],
    [Object.assign(new Error("odd"), { code: 23 }), false],
    [null, false],
    ["ECONNREFUSED", false],
  ])("never sent %p -> %p", (error, expected) => {
    expect(neverSent(error)).toBe(expected);
  });

  test("a dispatch error keeps the cause and its message", () => {
    const cause = new Error("upstream said no");
    const error = new TranscriptionDispatchError(cause, []);
    expect(error).toMatchObject({
      name: "TranscriptionDispatchError",
      message: "upstream said no",
    });
    expect(error.cause).toBe(cause);
    expect(new TranscriptionDispatchError("raw", []).message).toBe("raw");
  });
});

describe("recording fetch", () => {
  test("records the status of every answered attempt", async () => {
    const attempts: TranscriptionAttempt[] = [];
    const statuses = [500, 429];
    const fetch = recordingFetch(
      attempts,
      async () => new Response("", { status: statuses.shift() ?? 200 }),
    );
    await fetch("https://stt.example.test");
    await fetch("https://stt.example.test");
    expect(attempts).toEqual([answered(500), answered(429)]);
  });

  test("marks a connect failure as never sent and anything else as sent", async () => {
    const attempts: TranscriptionAttempt[] = [];
    const errors = [coded("ECONNREFUSED"), coded("ECONNRESET")];
    const fetch = recordingFetch(attempts, async () => {
      throw errors.shift();
    });
    await expect(fetch("https://stt.example.test")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(fetch("https://stt.example.test")).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(attempts).toEqual([{ phase: "unsent" }, { phase: "sent" }]);
  });

  test("counts a pending attempt as sent from the moment it is dispatched", () => {
    const attempts: TranscriptionAttempt[] = [];
    void recordingFetch(
      attempts,
      () => new Promise<Response>(() => {}),
    )("https://stt.example.test");
    expect(attempts).toEqual([{ phase: "sent" }]);
  });
});
