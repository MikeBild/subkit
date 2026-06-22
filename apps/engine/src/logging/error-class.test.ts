import { describe, expect, test } from "bun:test";
import { HttpError } from "../http/errors.ts";
import { LlmProviderError } from "../llm/errors.ts";
import { classifyError } from "./error-class.ts";

describe("classifyError", () => {
  test("null / undefined / non-Error → unknown", () => {
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
    expect(classifyError("a string")).toBe("unknown");
    expect(classifyError(new Error("plain"))).toBe("unknown");
  });

  test("libpq / socket teardown → transient", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "transient",
    );
    expect(classifyError(Object.assign(new Error("x"), { code: "57P01" }))).toBe("transient");
    expect(classifyError(new Error("Connection terminated unexpectedly"))).toBe("transient");
  });

  test("pg SQLSTATE auth / not-found / logic", () => {
    // 28P01 invalid_password → upstream_auth.
    expect(classifyError(Object.assign(new Error("auth"), { code: "28P01" }))).toBe(
      "upstream_auth",
    );
    // 3D000 invalid_catalog_name → resource.
    expect(classifyError(Object.assign(new Error("no db"), { code: "3D000" }))).toBe("resource");
    // 23505 unique_violation → a real query fault, classed logic.
    expect(classifyError(Object.assign(new Error("dup"), { code: "23505" }))).toBe("logic");
  });

  test("HTTP status buckets", () => {
    expect(classifyError(new HttpError(401, "unauthorized", "x"))).toBe("upstream_auth");
    expect(classifyError(new HttpError(403, "forbidden", "x"))).toBe("upstream_auth");
    expect(classifyError(new HttpError(404, "not_found", "x"))).toBe("upstream_4xx");
    expect(classifyError(new HttpError(408, "timeout", "x"))).toBe("timeout");
    expect(classifyError(new HttpError(500, "internal", "x"))).toBe("upstream_5xx");
    expect(classifyError(new HttpError(504, "gateway_timeout", "x"))).toBe("timeout");
  });

  test("LLM provider errors map through the provider classifier", () => {
    // A raw provider SDK error carrying a status code.
    expect(classifyError({ statusCode: 429, message: "rate limit" })).toBe("upstream_5xx");
    expect(classifyError({ statusCode: 529, message: "overloaded" })).toBe("upstream_5xx");
    // A typed LlmProviderError with a context_length kind → validation.
    expect(classifyError(new LlmProviderError("context_length_exceeded", "too many tokens"))).toBe(
      "validation",
    );
  });

  test("Zod-shaped validation errors → validation", () => {
    const zodLike = Object.assign(new Error("invalid"), {
      name: "ZodError",
      issues: [{ path: ["x"], message: "required" }],
    });
    expect(classifyError(zodLike)).toBe("validation");
  });

  test("transient wins over a SQLSTATE that also looks like a teardown", () => {
    // 57P03 cannot_connect_now is in the transient set — must not fall to logic.
    expect(classifyError(Object.assign(new Error("starting up"), { code: "57P03" }))).toBe(
      "transient",
    );
  });
});
