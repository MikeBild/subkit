// What the circuit breaker is allowed to count.
//
// The load-bearing assertions here are the NEGATIVE ones. A predicate that
// says yes to everything would open a breaker on the author's own typo and
// take a healthy connector offline for the whole reset window.

import { describe, expect, test } from "bun:test";

import { isAvailabilityFailure, isAvailabilityFailureFromError } from "./availability.ts";

describe("isAvailabilityFailure — the remote could not serve us", () => {
  test("5xx counts", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isAvailabilityFailure({ status })).toBe(true);
    }
  });

  test("429 counts — the remote is telling us it is over capacity", () => {
    expect(isAvailabilityFailure({ status: 429 })).toBe(true);
  });

  test("transport errno counts", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(isAvailabilityFailure({ code })).toBe(true);
    }
  });

  test("postgres connection/resource SQLSTATE classes count", () => {
    // 08006 connection failure, 53300 too many connections,
    // 57P01 admin shutdown.
    for (const code of ["08006", "53300", "57P01"]) {
      expect(isAvailabilityFailure({ code })).toBe(true);
    }
  });

  test("bare transport text counts when no code survived", () => {
    expect(isAvailabilityFailure({ message: "fetch failed" })).toBe(true);
    expect(isAvailabilityFailure({ message: "socket hang up" })).toBe(true);
  });
});

describe("isAvailabilityFailure — the request was wrong", () => {
  test("4xx other than 429 does NOT count", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isAvailabilityFailure({ status })).toBe(false);
    }
  });

  test("a SQL syntax error does NOT count", () => {
    // 42601 syntax_error, 42P01 undefined_table.
    expect(isAvailabilityFailure({ code: "42601", message: 'syntax error at or near ")"' })).toBe(
      false,
    );
    expect(isAvailabilityFailure({ code: "42P01" })).toBe(false);
  });

  test("an integrity violation does NOT count", () => {
    expect(isAvailabilityFailure({ code: "23505" })).toBe(false);
  });

  test("a missing S3 key does NOT count", () => {
    expect(isAvailabilityFailure({ status: 404, code: "NoSuchKey" })).toBe(false);
  });

  test("an unrecognised failure does NOT count", () => {
    // Conservative in the direction that matters: one extra request costs
    // less than a breaker opened on evidence we did not understand.
    expect(isAvailabilityFailure({ message: "something went wrong" })).toBe(false);
    expect(isAvailabilityFailure({})).toBe(false);
  });
});

describe("isAvailabilityFailureFromError", () => {
  test("unwraps the errno fetch hides in `cause`", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(isAvailabilityFailureFromError(err)).toBe(true);
  });

  test("a plain Error carrying a caller mistake does not count", () => {
    expect(isAvailabilityFailureFromError(new Error("connector config invalid"))).toBe(false);
  });

  test("a non-error value does not throw", () => {
    expect(isAvailabilityFailureFromError(null)).toBe(false);
    expect(isAvailabilityFailureFromError("nope")).toBe(false);
  });
});
