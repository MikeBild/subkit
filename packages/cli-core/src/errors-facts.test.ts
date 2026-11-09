import { describe, expect, test } from "bun:test";
import { engineErrorFacts } from "./errors-facts.ts";

describe("engineErrorFacts", () => {
  test("preserves the engine facts the facade reports", () => {
    expect(
      engineErrorFacts(429, {
        code: "rate_limited",
        message: "slow down",
        trace_id: "trace-1",
        hint: "retry later",
        retry_after: 1.2,
        details: { limit: 1 },
      }),
    ).toEqual({
      message: "slow down",
      code: "rate_limited",
      traceId: "trace-1",
      hint: "retry later",
      retryAfter: 2,
      details: { limit: 1 },
    });
  });

  test("rejects untrusted optional facts without changing the fallback contract", () => {
    expect(
      engineErrorFacts(503, { message: 3, retry_after: Number.NaN, details: undefined }),
    ).toEqual({
      message: "engine responded 503",
      code: "http_503",
      traceId: null,
      hint: null,
      retryAfter: null,
      details: null,
    });
    expect(engineErrorFacts(400, "bad request").message).toBe("bad request");
  });
});

test("primitive bodies and blank optional identifiers retain the public fallback contract", () => {
  for (const body of [undefined, null, false, 12, "", [], {}]) {
    expect(engineErrorFacts(502, body)).toEqual({
      message: "engine responded 502",
      code: "http_502",
      traceId: null,
      hint: null,
      retryAfter: null,
      details: null,
    });
  }
  expect(
    engineErrorFacts(400, {
      message: "",
      code: "",
      trace_id: "",
      hint: "",
      retry_after: -1,
      details: false,
    }),
  ).toEqual({ message: "", code: "", traceId: null, hint: null, retryAfter: 0, details: false });
  for (const retry_after of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null])
    expect(engineErrorFacts(429, { retry_after }).retryAfter).toBeNull();
});

test("retry delays round up nonnegative finite values without mutating the response", () => {
  for (const [delay, expected] of [
    [-10, 0],
    [-0.1, 0],
    [0, 0],
    [0.1, 1],
    [1, 1],
    [1.1, 2],
    [100.5, 101],
  ] as const) {
    const body = Object.freeze({ retry_after: delay });
    expect(engineErrorFacts(429, body).retryAfter).toBe(expected);
    expect(body.retry_after).toBe(delay);
  }
});

test("a callable object cannot supply trusted engine error fields", () => {
  const body = Object.assign(() => undefined, {
    message: "untrusted",
    code: "untrusted_code",
    trace_id: "untrusted_trace",
    retry_after: 10,
    details: { untrusted: true },
  });
  expect(engineErrorFacts(502, body)).toEqual({
    message: "engine responded 502",
    code: "http_502",
    traceId: null,
    hint: null,
    retryAfter: null,
    details: null,
  });
});

test("retry delays never coerce other value kinds into numbers", () => {
  for (const retry_after of [true, "2", 2n, Symbol("2"), [2], { valueOf: () => 2 }]) {
    expect(engineErrorFacts(429, { retry_after }).retryAfter).toBeNull();
  }
});
