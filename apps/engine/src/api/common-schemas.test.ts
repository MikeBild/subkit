import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, PaginationQuery, paginatedResponse } from "./common-schemas.ts";

describe("ErrorSchema", () => {
  test("accepts the minimal {code, message} envelope", () => {
    const ok = ErrorSchema.safeParse({ code: "not_found", message: "missing" });
    expect(ok.success).toBe(true);
  });

  test("accepts optional trace_id + details", () => {
    const ok = ErrorSchema.safeParse({
      code: "validation_failed",
      message: "bad input",
      trace_id: "abc123",
      details: { path: "body.name", expected: "string" },
    });
    expect(ok.success).toBe(true);
  });

  test("rejects missing code", () => {
    const r = ErrorSchema.safeParse({ message: "no code" });
    expect(r.success).toBe(false);
  });

  test("rejects non-string code", () => {
    const r = ErrorSchema.safeParse({ code: 42, message: "x" });
    expect(r.success).toBe(false);
  });
});

describe("PaginationQuery", () => {
  test("coerces string numerics from the URL query", () => {
    const r = PaginationQuery.safeParse({ limit: "50", offset: "10" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.offset).toBe(10);
    }
  });

  test("accepts an empty query (both fields optional)", () => {
    expect(PaginationQuery.safeParse({}).success).toBe(true);
  });

  test("rejects limit > 200 (the shared ceiling)", () => {
    expect(PaginationQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(PaginationQuery.safeParse({ limit: 1000 }).success).toBe(false);
  });

  test("rejects negative offset", () => {
    expect(PaginationQuery.safeParse({ offset: -1 }).success).toBe(false);
  });

  test("rejects non-integer limit", () => {
    expect(PaginationQuery.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  test("rejects zero or negative limit", () => {
    expect(PaginationQuery.safeParse({ limit: 0 }).success).toBe(false);
    expect(PaginationQuery.safeParse({ limit: -1 }).success).toBe(false);
  });
});

describe("IdParam", () => {
  test("accepts a v4 UUID string", () => {
    const r = IdParam.safeParse({ id: "11111111-2222-4333-8444-555555555555" });
    expect(r.success).toBe(true);
  });

  test("rejects a slug-shaped string", () => {
    expect(IdParam.safeParse({ id: "my-connector" }).success).toBe(false);
  });

  test("rejects an empty string", () => {
    expect(IdParam.safeParse({ id: "" }).success).toBe(false);
  });

  test("rejects a missing id", () => {
    expect(IdParam.safeParse({}).success).toBe(false);
  });
});

describe("paginatedResponse", () => {
  const Item = z.object({ id: z.string(), name: z.string() });
  const ListResponse = paginatedResponse(Item, "TestList");

  test("round-trips items and a string cursor", () => {
    const ok = ListResponse.safeParse({
      items: [{ id: "a", name: "alpha" }],
      next_cursor: "cursor-abc",
    });
    expect(ok.success).toBe(true);
  });

  test("accepts null cursor (no more pages)", () => {
    const ok = ListResponse.safeParse({
      items: [],
      next_cursor: null,
    });
    expect(ok.success).toBe(true);
  });

  test("accepts absent cursor (offset-paginated route)", () => {
    const ok = ListResponse.safeParse({ items: [{ id: "x", name: "X" }] });
    expect(ok.success).toBe(true);
  });

  test("rejects items shaped like the wrong schema", () => {
    const r = ListResponse.safeParse({ items: [{ id: 1, name: 2 }] });
    expect(r.success).toBe(false);
  });

  test("rejects missing items", () => {
    expect(ListResponse.safeParse({ next_cursor: null }).success).toBe(false);
  });
});
