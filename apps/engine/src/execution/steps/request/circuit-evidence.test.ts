import { describe, expect, test } from "bun:test";
import type { ConnectorResolutionSummary, RequestMeta } from "../../types.ts";
import {
  type ConnectorEvidence,
  evidenceFromStatus,
  evidenceFromThrow,
  graphqlEvidence,
  mcpEvidence,
  requestFailureEvidence,
} from "./circuit-evidence.ts";
import { RequestError } from "./errors.ts";

describe("evidenceFromStatus", () => {
  test("a 5xx or a 429 is the remote saying it could not serve", () => {
    expect(evidenceFromStatus(500)).toBe("unavailable");
    expect(evidenceFromStatus(502)).toBe("unavailable");
    expect(evidenceFromStatus(503)).toBe("unavailable");
    expect(evidenceFromStatus(429)).toBe("unavailable");
  });

  test("every other status is an answer, however unwelcome", () => {
    expect(evidenceFromStatus(200)).toBe("answered");
    expect(evidenceFromStatus(204)).toBe("answered");
    expect(evidenceFromStatus(400)).toBe("answered");
    expect(evidenceFromStatus(403)).toBe("answered");
    expect(evidenceFromStatus(404)).toBe("answered");
  });
});

describe("evidenceFromThrow", () => {
  test("a transport failure is evidence about reachability", () => {
    expect(evidenceFromThrow(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      "unavailable",
    );
    expect(evidenceFromThrow(new Error("fetch failed"))).toBe("unavailable");
  });

  test("an exception is never treated as an answer", () => {
    expect(evidenceFromThrow(new Error("headers must be a flat object"))).toBe("none");
    expect(evidenceFromThrow(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(
      "none",
    );
  });
});

describe("requestFailureEvidence", () => {
  test("a 5xx or a 429 the retry loop gave up on counts", () => {
    expect(requestFailureEvidence(new RequestError("http 503", "http_5xx", 503), false)).toBe(
      "unavailable",
    );
    expect(requestFailureEvidence(new RequestError("http 429", "http_429", 429), false)).toBe(
      "unavailable",
    );
  });

  test("a rejected credential or a wrong path is an answer, not an outage", () => {
    expect(requestFailureEvidence(new RequestError("http 401", "http_4xx", 401), false)).toBe(
      "answered",
    );
    expect(requestFailureEvidence(new RequestError("http 404", "http_4xx", 404), false)).toBe(
      "answered",
    );
    expect(requestFailureEvidence(new RequestError("filter rejected", "filter_fail"), false)).toBe(
      "answered",
    );
  });

  test("a transport failure counts whatever the runtime called it", () => {
    expect(requestFailureEvidence(new RequestError("Unable to connect", "connection"), false)).toBe(
      "unavailable",
    );
    const fallback = new RequestError("connection error", "connection");
    expect(evidenceFromThrow(fallback)).toBe("none");
    expect(requestFailureEvidence(fallback, false)).toBe("unavailable");
    expect(requestFailureEvidence(new RequestError("gave up waiting", "timeout"), false)).toBe(
      "unavailable",
    );
  });

  test("an abort counts only when the step's own timer fired", () => {
    expect(requestFailureEvidence(new RequestError("aborted", "abort"), true)).toBe("unavailable");
    expect(requestFailureEvidence(new RequestError("aborted", "abort"), false)).toBe("none");
  });

  test("a request refused before it left observes nothing", () => {
    expect(
      requestFailureEvidence(new RequestError("invalid header name", "request_invalid"), false),
    ).toBe("none");
    expect(
      requestFailureEvidence(new RequestError("authority changed", "authority_invalid"), false),
    ).toBe("none");
  });

  test("anything else thrown is read like any driver error", () => {
    expect(requestFailureEvidence(new Error("fetch failed"), false)).toBe("unavailable");
    expect(requestFailureEvidence(new Error("no credential for connector"), false)).toBe("none");
  });
});

describe("graphqlEvidence", () => {
  const connector: ConnectorResolutionSummary = {
    step_key: "gql",
    connector_id: "c",
    connector_slug: "s",
    driver: "graphql",
    requested_environment: "dev",
    resolved_environment: "dev",
    auth_method: "none",
  };
  const meta = (status: number): RequestMeta => ({
    driver: "graphql",
    method: "POST",
    status,
    connector,
  });

  test("a succeeded result is an answer", () => {
    expect(graphqlEvidence({ status: "succeeded", request_meta: meta(200) })).toBe("answered");
  });

  test("an exhausted retry loop against a 5xx counts against the breaker", () => {
    expect(
      graphqlEvidence({
        status: "failed",
        request_meta: meta(502),
        error: { code: "graphql_502", message: "graphql endpoint returned 502" },
      }),
    ).toBe("unavailable");
  });

  test("an errors array on a 200 is an answer — the endpoint is serving", () => {
    expect(
      graphqlEvidence({
        status: "failed",
        request_meta: meta(200),
        error: {
          code: "graphql_error",
          message: "graphql response returned errors: no such field",
        },
      }),
    ).toBe("answered");
  });

  test("a 4xx is an answer, not an outage", () => {
    expect(
      graphqlEvidence({
        status: "failed",
        request_meta: meta(422),
        error: { code: "graphql_422", message: "graphql endpoint returned 422" },
      }),
    ).toBe("answered");
  });

  test("no request_meta means no response arrived, so the throw decides", () => {
    expect(
      graphqlEvidence({
        status: "failed",
        error: { code: "graphql_error", message: "fetch failed" },
      }),
    ).toBe("unavailable");
    expect(
      graphqlEvidence({
        status: "failed",
        error: { code: "request_invalid", message: "header value must be a string" },
      }),
    ).toBe("none");
  });
});

describe("mcpEvidence", () => {
  test("a succeeded call is an answer", () => {
    expect(mcpEvidence({ status: "succeeded" })).toBe("answered");
  });

  test("mcp_unavailable counts, mcp_remote_error does not", () => {
    expect(
      mcpEvidence({ status: "failed", error: { code: "mcp_unavailable", message: "no session" } }),
    ).toBe("unavailable");
    expect(
      mcpEvidence({
        status: "failed",
        error: { code: "mcp_remote_error", message: "tool reported an error" },
      }),
    ).toBe("answered");
  });

  test("a cancelled run, and any code this function has not been taught, observes nothing", () => {
    expect(
      mcpEvidence({ status: "failed", error: { code: "mcp_cancelled", message: "aborted" } }),
    ).toBe("none");
    expect(
      mcpEvidence({ status: "failed", error: { code: "mcp_step_invalid", message: "bad tool" } }),
    ).toBe("none");
  });
});

describe("the vocabulary is exactly three verdicts", () => {
  test("every classifier returns one of them", () => {
    const all: ConnectorEvidence[] = [
      evidenceFromStatus(500),
      evidenceFromStatus(200),
      evidenceFromThrow(new Error("x")),
      graphqlEvidence({ status: "succeeded" }),
      mcpEvidence({ status: "succeeded" }),
    ];
    for (const v of all) expect(["answered", "unavailable", "none"]).toContain(v);
  });
});
