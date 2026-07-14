// Unit tests for isGraphqlRetryable.
// Pure function — no database, no network.

import { describe, expect, test } from "bun:test";
import { classifyGraphqlSchemaError, isGraphqlRetryable } from "./graphql-retry-classify.ts";

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

describe("classifyGraphqlSchemaError · no signal", () => {
  test("missing errors key → not schema-shaped", () => {
    expect(classifyGraphqlSchemaError({ data: { ok: true } })).toEqual({
      schema_shaped: false,
      root_field: null,
    });
  });

  test("empty errors array → not schema-shaped", () => {
    expect(classifyGraphqlSchemaError({ errors: [] })).toEqual({
      schema_shaped: false,
      root_field: null,
    });
  });

  test("errors with unrelated code → not schema-shaped", () => {
    expect(
      classifyGraphqlSchemaError({
        errors: [{ message: "boom", extensions: { code: "UNAUTHENTICATED" } }],
      }),
    ).toEqual({ schema_shaped: false, root_field: null });
  });
});

describe("classifyGraphqlSchemaError · structured extensions.code", () => {
  test("GRAPHQL_VALIDATION_FAILED code → schema-shaped, root field from qualified message", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        {
          message: "Cannot query field Query.chargers",
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("chargers");
  });

  test("errorType FieldUndefined (graphql-java) → schema-shaped", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "no such field", errorType: "FieldUndefined" }],
    });
    expect(verdict.schema_shaped).toBe(true);
  });

  test("extensions.classification NOT_IMPLEMENTED → schema-shaped", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "unsupported", extensions: { classification: "NOT_IMPLEMENTED" } }],
    });
    expect(verdict.schema_shaped).toBe(true);
  });
});

describe("classifyGraphqlSchemaError · message-phrase fallback (no structured fields)", () => {
  test("'cannot query field' phrase with single-quoted field name extracts root_field", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "Cannot query field 'chargers' on type Query" }],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("chargers");
  });

  test("Hasura 'not found in type' phrase → schema-shaped", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "field 'widgets' not found in type: 'query_root'" }],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("widgets");
  });

  test("double-quoted 'cannot query field' phrase extracts root_field", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: 'Cannot query field "widgets" on type "Query".' }],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("widgets");
  });

  test("phrase without any extractable field name → schema-shaped with null root_field", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [{ message: "not_implemented: this operation has no resolver" }],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBeNull();
  });

  test("prose message with no schema phrase → not schema-shaped", () => {
    expect(
      classifyGraphqlSchemaError({ errors: [{ message: "internal server hiccup, try later" }] }),
    ).toEqual({ schema_shaped: false, root_field: null });
  });
});

describe("classifyGraphqlSchemaError · transient beats schema", () => {
  test("a throttled entry is never classified as schema drift even with a schema-sounding message", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        {
          message: "cannot query field while throttled",
          extensions: { code: "THROTTLING" },
        },
      ],
    });
    expect(verdict).toEqual({ schema_shaped: false, root_field: null });
  });

  test("mixed batch: transient entry skipped, schema entry still classified", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        { message: "rate limited", extensions: { code: "THROTTLING" } },
        { message: "Cannot query field 'ghost' on type Query", extensions: {} },
      ],
    });
    expect(verdict.schema_shaped).toBe(true);
    expect(verdict.root_field).toBe("ghost");
  });

  test("non-object entries in the errors array are skipped without throwing", () => {
    expect(classifyGraphqlSchemaError({ errors: [null, "not-an-object", 42] })).toEqual({
      schema_shaped: false,
      root_field: null,
    });
  });

  test("first matching root_field wins when multiple schema entries are present", () => {
    const verdict = classifyGraphqlSchemaError({
      errors: [
        { message: "Cannot query field 'first' on type Query" },
        { message: "Cannot query field 'second' on type Query" },
      ],
    });
    expect(verdict.root_field).toBe("first");
  });
});
