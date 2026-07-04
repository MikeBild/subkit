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

  test("connector fetch deadline (AbortSignal.timeout / abort) → timeout", () => {
    // AbortSignal.timeout() aborts with a DOMException name "TimeoutError".
    expect(
      classifyError(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })),
    ).toBe("timeout");
    // Manual abort → "AbortError".
    expect(
      classifyError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    ).toBe("timeout");
    // undici read/connect deadline codes.
    expect(
      classifyError(
        Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      ),
    ).toBe("timeout");
  });

  test("connector network unreachable (DNS / routing) → transient", () => {
    expect(
      classifyError(Object.assign(new Error("getaddrinfo ENOTFOUND api.x"), { code: "ENOTFOUND" })),
    ).toBe("transient");
    expect(classifyError(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }))).toBe("transient");
    expect(classifyError(Object.assign(new Error("net"), { code: "EHOSTUNREACH" }))).toBe(
      "transient",
    );
  });

  test("fetch failure wraps the real signal on .cause → unwrapped (was 'unknown')", () => {
    // `fetch` rejects with a `TypeError: fetch failed`; the socket errno is on
    // `.cause`. This is the exact shape that was logging error_class:"unknown".
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(classifyError(fetchFailed)).toBe("transient");

    const dnsFetch = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    expect(classifyError(dnsFetch)).toBe("transient");

    // A higher-level error wrapping a typed HttpError still classifies.
    const wrapped = new Error("step failed", { cause: new HttpError(503, "unavailable", "x") });
    expect(classifyError(wrapped)).toBe("upstream_5xx");
  });

  test("Bun fetch error codes (production runtime) classify", () => {
    // The engine ships as a Bun binary; a connector fetch to a refused /
    // unresolvable / unreachable host all throw `code: "ConnectionRefused"`.
    // This is the exact production shape that was logging error_class:"unknown".
    expect(
      classifyError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })),
    ).toBe("transient");
    expect(classifyError(Object.assign(new Error("closed"), { code: "ConnectionClosed" }))).toBe(
      "transient",
    );
    expect(classifyError(Object.assign(new Error("socket"), { code: "FailedToOpenSocket" }))).toBe(
      "transient",
    );
    // Bun timeout / abort surface by name (DOMException codes 23 / 20).
    expect(
      classifyError(Object.assign(new Error("timed out"), { name: "TimeoutError", code: 23 })),
    ).toBe("timeout");
    expect(
      classifyError(Object.assign(new Error("aborted"), { name: "AbortError", code: 20 })),
    ).toBe("timeout");
  });

  test("Bun DNS resolution failure (UnknownHostName) → transient", () => {
    expect(
      classifyError(Object.assign(new Error("unknown host"), { code: "UnknownHostName" })),
    ).toBe("transient");
  });

  test("undici abort codes → timeout", () => {
    expect(classifyError(Object.assign(new Error("aborted"), { code: "UND_ERR_ABORTED" }))).toBe(
      "timeout",
    );
  });

  test("TLS / certificate verification failures → upstream_tls (distinct remediation)", () => {
    // OpenSSL X509 verify codes (Node tls.html); Bun surfaces the same on .code.
    for (const code of [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "HOSTNAME_MISMATCH",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      expect(classifyError(Object.assign(new Error("cert"), { code }))).toBe("upstream_tls");
    }
    // A cert error wrapped by `fetch` on `.cause` still classifies.
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    });
    expect(classifyError(wrapped)).toBe("upstream_tls");
  });

  test("PostgreSQL SQLSTATE class dispatch (retryable / resource / timeout / privilege)", () => {
    // 40001 serialization_failure & 40P01 deadlock_detected are RETRYABLE.
    expect(classifyError(Object.assign(new Error("serialize"), { code: "40001" }))).toBe(
      "transient",
    );
    expect(classifyError(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(
      "transient",
    );
    // 53xxx insufficient_resources → resource (not a query bug).
    expect(classifyError(Object.assign(new Error("too many conns"), { code: "53300" }))).toBe(
      "resource",
    );
    // 57014 query_canceled (statement_timeout) → timeout.
    expect(classifyError(Object.assign(new Error("canceled"), { code: "57014" }))).toBe("timeout");
    // 42501 insufficient_privilege → auth; other class-42 stays logic.
    expect(classifyError(Object.assign(new Error("denied"), { code: "42501" }))).toBe(
      "upstream_auth",
    );
    expect(classifyError(Object.assign(new Error("syntax"), { code: "42601" }))).toBe("logic");
    // 22xxx data_exception → validation; 23505 constraint stays logic.
    expect(classifyError(Object.assign(new Error("range"), { code: "22003" }))).toBe("validation");
    expect(classifyError(Object.assign(new Error("dup"), { code: "23505" }))).toBe("logic");
  });

  test("a self-referential cause cannot loop", () => {
    const e = new Error("loopy") as Error & { cause?: unknown };
    e.cause = e;
    expect(classifyError(e)).toBe("unknown");
  });
});
