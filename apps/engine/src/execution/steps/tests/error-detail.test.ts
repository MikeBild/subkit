import { describe, expect, test } from "bun:test";
import { buildStepErrorDetail } from "../error-detail.ts";

describe("buildStepErrorDetail", () => {
  test("falls back to a useful message for non-Error throwables", () => {
    const detail = buildStepErrorDetail({
      code: "request_error",
      err: { foo: "bar" },
    });
    expect(detail.message).not.toBe("[object Object]");
    expect(detail.code).toBe("request_error");
  });

  test("prefers err.message when present", () => {
    const detail = buildStepErrorDetail({ code: "x", err: new Error("boom") });
    expect(detail.message).toBe("boom");
  });

  test("threads response body excerpt + upstream status from RequestError.meta", () => {
    class FakeRequestError extends Error {
      constructor() {
        super("http 404");
        this.cause_kind = "http_4xx";
        this.status = 404;
        this.meta = {
          body: { error: "Not Found" },
          headers: { "content-type": "application/json" },
        };
      }
      cause_kind: string;
      status: number;
      meta: Record<string, unknown>;
    }
    const detail = buildStepErrorDetail({
      code: "http_4xx",
      err: new FakeRequestError(),
    });
    expect(detail.upstream_status).toBe(404);
    expect(detail.response_body_excerpt).toContain("Not Found");
    expect(detail.response_headers).toEqual({ "content-type": "application/json" });
  });

  test("strips auth-bearing headers from response_headers", () => {
    class FakeRequestError extends Error {
      constructor() {
        super("http 401");
        this.status = 401;
        this.meta = {
          body: "unauthorized",
          headers: {
            "content-type": "text/plain",
            "set-cookie": "session=secret",
            authorization: "Bearer leaked",
            "x-api-key": "k",
          },
        };
      }
      status: number;
      meta: Record<string, unknown>;
    }
    const detail = buildStepErrorDetail({ code: "http_4xx", err: new FakeRequestError() });
    expect(detail.response_headers).toEqual({ "content-type": "text/plain" });
  });

  test("populates resolved_url from request_meta", () => {
    const detail = buildStepErrorDetail({
      code: "request_error",
      err: new Error("connection reset"),
      request_meta: {
        driver: "http",
        url: "https://api.example.com/v2/projects/abc/resources",
        method: "GET",
        connector: {
          step_key: "x",
          connector_id: "id",
          connector_slug: "digitalocean",
          driver: "http",
          requested_environment: "dev",
          resolved_environment: "dev",
          auth_method: "bearer",
          base_url: "https://api.example.com/v2",
        },
      },
    });
    expect(detail.resolved_url).toBe("https://api.example.com/v2/projects/abc/resources");
  });

  test("truncates very long bodies to ~4 KB", () => {
    const huge = "x".repeat(20_000);
    class FakeRequestError extends Error {
      constructor() {
        super("http 500");
        this.status = 500;
        this.meta = { body: huge };
      }
      status: number;
      meta: Record<string, unknown>;
    }
    const detail = buildStepErrorDetail({ code: "http_5xx", err: new FakeRequestError() });
    expect(detail.response_body_excerpt).toBeDefined();
    expect(detail.response_body_excerpt!.length).toBeLessThan(huge.length / 2);
    expect(detail.response_body_excerpt).toContain("…[truncated]");
  });

  test("respects explicit message override", () => {
    const detail = buildStepErrorDetail({
      code: "step_timeout",
      err: new Error("internal abort"),
      message: "request exceeded 60000ms",
    });
    expect(detail.message).toBe("request exceeded 60000ms");
  });

  test("returns a non-empty message even for null / undefined inputs", () => {
    expect(buildStepErrorDetail({ code: "x", err: null }).message).toBeTruthy();
    expect(buildStepErrorDetail({ code: "x", err: undefined }).message).toBeTruthy();
  });

  test("extracts .message from JSONata runtime-shape throwables (plain object, no Error proto)", () => {
    const jsonataRuntimeErr = {
      code: "T2001",
      position: 42,
      token: "$match",
      message:
        "The second argument of the $match function must be a function that returns an object",
    };
    const detail = buildStepErrorDetail({ code: "transform_error", err: jsonataRuntimeErr });
    expect(detail.message).not.toBe("[object Object]");
    expect(detail.message).toContain("$match");
  });

  test("does not propagate the literal '[object Object]' string from a poisoned Error", () => {
    const poisoned = new Error("[object Object]");
    const detail = buildStepErrorDetail({ code: "transform_error", err: poisoned });
    expect(detail.message).not.toBe("[object Object]");
    expect(detail.message).toContain("transform_error");
  });

  test("prefers err.cause.message when the outer Error's message is poisoned", () => {
    const cause = new Error("Function 'foo' not found");
    const poisoned = new Error("[object Object]");
    (poisoned as { cause?: unknown }).cause = cause;
    const detail = buildStepErrorDetail({ code: "transform_error", err: poisoned });
    expect(detail.message).toBe("Function 'foo' not found");
  });

  test("does not propagate the literal '[object Object]' string from a poisoned plain-object .message", () => {
    const detail = buildStepErrorDetail({
      code: "transform_error",
      err: { message: "[object Object]", code: "T9999", token: "$munge" },
    });
    expect(detail.message).not.toBe("[object Object]");
    expect(detail.message).toContain("T9999");
    expect(detail.message).toContain("$munge");
  });
});
