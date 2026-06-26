// Unit tests for isGraphqlRetryable.
// Pure function — no database, no network.

import { describe, expect, test } from "bun:test";
import { isGraphqlRetryable } from "./graphql-retry-classify.ts";

describe("isGraphqlRetryable · HTTP status", () => {
  test("429 is retryable", () => {
    expect(isGraphqlRetryable(429, {})).toBe(true);
  });

  test("500 is retryable", () => {
    expect(isGraphqlRetryable(500, {})).toBe(true);
  });

  test("503 is retryable", () => {
    expect(isGraphqlRetryable(503, {})).toBe(true);
  });

  test("501 is NOT retryable — not implemented is permanent", () => {
    expect(isGraphqlRetryable(501, {})).toBe(false);
  });

  test("200 without errors is not retryable", () => {
    expect(isGraphqlRetryable(200, { data: { items: [] } })).toBe(false);
  });

  test("400 without errors is not retryable", () => {
    expect(isGraphqlRetryable(400, {})).toBe(false);
  });
});

describe("isGraphqlRetryable · structured extensions.code", () => {
  test("THROTTLING code → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { code: "THROTTLING" } }],
      }),
    ).toBe(true);
  });

  test("RATE_LIMITED code → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { code: "RATE_LIMITED" } }],
      }),
    ).toBe(true);
  });

  test("INTERNAL_SERVER_ERROR code → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      }),
    ).toBe(true);
  });

  test("UNAUTHENTICATED code → NOT retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { code: "UNAUTHENTICATED" } }],
      }),
    ).toBe(false);
  });

  test("case-insensitive match on code", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { code: "throttled" } }],
      }),
    ).toBe(true);
  });
});

describe("isGraphqlRetryable · errorType (AWS/AppSync)", () => {
  test("ThrottlingException errorType → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "Rate exceeded", errorType: "ThrottlingException" }],
      }),
    ).toBe(true);
  });

  test("ServiceUnavailableException errorType → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "Service unavailable", errorType: "ServiceUnavailableException" }],
      }),
    ).toBe(true);
  });

  test("ValidationError errorType → NOT retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "Validation failed", errorType: "ValidationError" }],
      }),
    ).toBe(false);
  });
});

describe("isGraphqlRetryable · extensions.classification", () => {
  test("RATE_LIMIT classification → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { classification: "RATE_LIMIT" } }],
      }),
    ).toBe(true);
  });

  test("INTERNAL classification → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { classification: "INTERNAL" } }],
      }),
    ).toBe(true);
  });

  test("FORBIDDEN classification → NOT retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { classification: "FORBIDDEN" } }],
      }),
    ).toBe(false);
  });
});

describe("isGraphqlRetryable · extensions.http.status", () => {
  test("extensions.http.status 503 → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { http: { status: 503 } } }],
      }),
    ).toBe(true);
  });

  test("extensions.http.status 429 → retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { http: { status: 429 } } }],
      }),
    ).toBe(true);
  });

  test("extensions.http.status 400 → NOT retryable", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "x", extensions: { http: { status: 400 } } }],
      }),
    ).toBe(false);
  });
});

describe("isGraphqlRetryable · message substring (last resort)", () => {
  test("message containing 'THROTTLE' → retryable when no structured signal", () => {
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "Requests are being throttled. Try again later." }],
      }),
    ).toBe(true);
  });

  test("message with structured non-retryable code overrides retryable message substring", () => {
    // extensions.code=FORBIDDEN (not retryable) should win over a message
    // that happens to contain 'TIMEOUT' text.
    expect(
      isGraphqlRetryable(200, {
        errors: [{ message: "TIMEOUT on forbidden path", extensions: { code: "FORBIDDEN" } }],
      }),
    ).toBe(false);
  });

  test("empty errors array → not retryable", () => {
    expect(isGraphqlRetryable(200, { errors: [] })).toBe(false);
  });

  test("missing errors key → not retryable", () => {
    expect(isGraphqlRetryable(200, { data: { ok: true } })).toBe(false);
  });
});
