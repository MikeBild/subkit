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

  test("SQL Server (tedious/mssql) connection codes classify", () => {
    expect(classifyError(Object.assign(new Error("login failed"), { code: "ELOGIN" }))).toBe(
      "upstream_auth",
    );
    // tedious ETIMEOUT (no D) is its own code, distinct from POSIX ETIMEDOUT.
    expect(classifyError(Object.assign(new Error("conn timeout"), { code: "ETIMEOUT" }))).toBe(
      "timeout",
    );
    expect(classifyError(Object.assign(new Error("socket"), { code: "ESOCKET" }))).toBe(
      "transient",
    );
    expect(classifyError(Object.assign(new Error("instance"), { code: "EINSTLOOKUP" }))).toBe(
      "transient",
    );
    expect(classifyError(Object.assign(new Error("tls"), { code: "EENCRYPT" }))).toBe(
      "upstream_tls",
    );
    // Lifecycle misuse on a closed/not-open pool is deterministic → logic, NOT a
    // retryable transient bounce (node-mssql wrapper codes).
    expect(classifyError(Object.assign(new Error("closed"), { code: "ECONNCLOSED" }))).toBe(
      "logic",
    );
    expect(classifyError(Object.assign(new Error("not open"), { code: "ENOTOPEN" }))).toBe("logic");
    // A request-level SQL Server message stays unknown (needs the SQL number).
    expect(classifyError(Object.assign(new Error("msg"), { code: "EREQUEST" }))).toBe("unknown");
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

  test("SMB NTSTATUS codes classify", () => {
    expect(classifyError(Object.assign(new Error("logon"), { code: "STATUS_LOGON_FAILURE" }))).toBe(
      "upstream_auth",
    );
    expect(
      classifyError(Object.assign(new Error("share"), { code: "STATUS_BAD_NETWORK_NAME" })),
    ).toBe("resource");
    expect(
      classifyError(Object.assign(new Error("nofile"), { code: "STATUS_OBJECT_NAME_NOT_FOUND" })),
    ).toBe("resource");
    expect(classifyError(Object.assign(new Error("to"), { code: "STATUS_TIMEOUT" }))).toBe(
      "timeout",
    );
  });

  test("basic-ftp FTPError numeric reply codes classify", () => {
    const ftp = (code: number) => Object.assign(new Error("ftp"), { name: "FTPError", code });
    expect(classifyError(ftp(530))).toBe("upstream_auth"); // not logged in
    expect(classifyError(ftp(550))).toBe("resource"); // file unavailable
    expect(classifyError(ftp(421))).toBe("transient"); // service not available
    expect(classifyError(ftp(502))).toBe("logic"); // command not implemented
    // A bare Error with a numeric code but no FTPError name is NOT treated as FTP.
    expect(classifyError(Object.assign(new Error("x"), { code: 530 }))).toBe("unknown");
  });

  test("SFTP (ssh2-sftp-client) wrapper codes classify", () => {
    expect(classifyError(Object.assign(new Error("noent"), { code: "ENOENT" }))).toBe("resource");
    expect(classifyError(Object.assign(new Error("perm"), { code: "EACCES" }))).toBe(
      "upstream_auth",
    );
    expect(classifyError(Object.assign(new Error("not conn"), { code: "ERR_NOT_CONNECTED" }))).toBe(
      "logic",
    );
  });

  test("node-redis client error classes classify by constructor name", () => {
    // node-redis classes set no .code/.name — only the constructor name is the
    // discriminator. Simulate with same-named local classes.
    class ConnectionTimeoutError extends Error {}
    class SocketClosedUnexpectedlyError extends Error {}
    class WatchError extends Error {}
    class CredentialsError extends Error {}
    expect(classifyError(new ConnectionTimeoutError("Connection timeout"))).toBe("timeout");
    expect(classifyError(new SocketClosedUnexpectedlyError("closed"))).toBe("transient");
    expect(classifyError(new WatchError("watched key changed"))).toBe("logic");
    expect(classifyError(new CredentialsError("creds"))).toBe("upstream_auth");
  });

  test("node-redis server reply errors classify by RESP protocol token", () => {
    class ErrorReply extends Error {}
    expect(classifyError(new ErrorReply("NOAUTH Authentication required."))).toBe("upstream_auth");
    expect(classifyError(new ErrorReply("WRONGPASS invalid username-password pair"))).toBe(
      "upstream_auth",
    );
    expect(classifyError(new ErrorReply("CLUSTERDOWN Hash slot not served"))).toBe("upstream_5xx");
    expect(classifyError(new ErrorReply("LOADING Redis is loading the dataset"))).toBe(
      "upstream_5xx",
    );
    expect(classifyError(new ErrorReply("WRONGTYPE Operation against a key…"))).toBe("logic");
    expect(classifyError(new ErrorReply("OOM command not allowed"))).toBe("resource");
    // An unrecognized reply token does not force a bucket.
    expect(classifyError(new ErrorReply("ERR unknown command"))).toBe("unknown");
    // The token-parse only applies to redis reply classes — a generic Error
    // whose message starts with "NOAUTH" must NOT be classified as redis.
    expect(classifyError(new Error("NOAUTH something unrelated"))).toBe("unknown");
  });

  test("a self-referential cause cannot loop", () => {
    const e = new Error("loopy") as Error & { cause?: unknown };
    e.cause = e;
    expect(classifyError(e)).toBe("unknown");
  });
});
