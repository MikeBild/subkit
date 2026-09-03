import { describe, expect, test } from "bun:test";
import { isUndefinedTable } from "../environment.ts";

describe("check 2 on a fresh database", () => {
  test("recognises the undefined table through the driver's wrapper", () => {
    // Measured 2026-09-03 (6.27.3 compose smoke): the driver throws
    // "Failed query: SELECT … params:" and keeps the PostgreSQL error as
    // `cause`. The SQLSTATE lives one level down.
    const wrapped = new Error(
      'Failed query: SELECT hash, tag FROM "subkit"."__drizzle_migrations" ORDER BY id params:',
      {
        cause: Object.assign(new Error('relation "subkit.__drizzle_migrations" does not exist'), {
          code: "42P01",
        }),
      },
    );
    expect(isUndefinedTable(wrapped)).toBe(true);
  });

  test("still recognises a bare SQLSTATE and a bare message", () => {
    expect(isUndefinedTable(Object.assign(new Error("x"), { code: "42P01" }))).toBe(true);
    expect(
      isUndefinedTable(new Error('relation "subkit.__drizzle_migrations" does not exist')),
    ).toBe(true);
  });

  test("a real outage is not a fresh database", () => {
    const wrapped = new Error("Failed query: SELECT 1 params:", {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    });
    expect(isUndefinedTable(wrapped)).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
