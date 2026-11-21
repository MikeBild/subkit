import { describe, expect, test } from "bun:test";
import { RequestStepSchema } from "../types.ts";

describe("RequestStepSchema headers — RFC 7230 token guard", () => {
  test("accepts a record headers value", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "GET",
      url: "https://example.com",
      headers: { Accept: "application/json" },
    });
    expect(r.success).toBe(true);
  });

  test("accepts the multi-line `Name: Value` string form", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "GET",
      url: "https://example.com",
      headers: "Accept: application/json\nX-Trace: abc",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.headers).toEqual({ Accept: "application/json", "X-Trace": "abc" });
  });

  test("rejects a JSON-encoded object string (the 730c568a regression)", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "GET",
      url: "https://example.com",
      headers: '{"Accept": "application/vnd.github+json"}',
    });
    expect(r.success).toBe(false);
  });

  test("rejects header names with non-token characters", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "GET",
      url: "https://example.com",
      headers: '{"Accept": "x"',
    });
    expect(r.success).toBe(false);
  });
});

describe("RequestStepSchema graphql — JSON-encoded string guard", () => {
  test("accepts an object form", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "POST",
      url: "https://example.com",
      graphql: { query: "{ me { id } }" },
    });
    expect(r.success).toBe(true);
  });

  test("accepts a raw GraphQL document string", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "POST",
      url: "https://example.com",
      graphql: "{ me { id } }",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const g = r.data.graphql as { query: string } | undefined;
    expect(g?.query).toContain("me");
  });

  test("rejects a JSON-encoded object string", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "POST",
      url: "https://example.com",
      graphql: '{"query":"{ me { id } }"}',
    });
    expect(r.success).toBe(false);
  });

  test("rejects a JSON-encoded array string", () => {
    const r = RequestStepSchema.safeParse({
      id: "s",
      kind: "request",
      method: "POST",
      url: "https://example.com",
      graphql: '[{"query":"x"}]',
    });
    expect(r.success).toBe(false);
  });
});
