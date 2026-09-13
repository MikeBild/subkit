// Unit tests for buildProbeDiagnostics.
//
// Pure helper — no server, no DB. Covers body truncation, JSON
// stringification, secret scrubbing, and the header allowlist.

import { describe, expect, test } from "bun:test";

import { buildProbeDiagnostics } from "./probe-diagnostics.ts";

describe("buildProbeDiagnostics — body snippet", () => {
  test("body > 500 chars is truncated at 500 with a remainder tail", () => {
    const body = "a".repeat(750);
    const d = buildProbeDiagnostics(undefined, body);
    expect(d.body_snippet).toBe(`${"a".repeat(500)}… [+250 chars]`);
  });

  test("body ≤ 500 chars passes through unmodified, no tail", () => {
    const body = "short error body";
    const d = buildProbeDiagnostics(undefined, body);
    expect(d.body_snippet).toBe("short error body");
  });

  test("object body is JSON.stringify'd", () => {
    const body = { errors: [{ message: "Basic auth is not allowed" }] };
    const d = buildProbeDiagnostics(undefined, body);
    expect(d.body_snippet).toBe(JSON.stringify(body));
  });

  test("null and undefined bodies produce no snippet", () => {
    expect(buildProbeDiagnostics(undefined, null).body_snippet).toBeUndefined();
    expect(buildProbeDiagnostics(undefined, undefined).body_snippet).toBeUndefined();
  });

  test("circular body produces no snippet (JSON.stringify throws)", () => {
    const body: Record<string, unknown> = {};
    body.self = body;
    expect(buildProbeDiagnostics(undefined, body).body_snippet).toBeUndefined();
  });

  test("empty string body produces no snippet", () => {
    expect(buildProbeDiagnostics(undefined, "").body_snippet).toBeUndefined();
  });

  test("secrets in the body are scrubbed (ghp_ PAT never present)", () => {
    const token = `ghp_${"A1b2C3d4E5".repeat(3)}`; // ghp_ + 30 alnum chars
    const d = buildProbeDiagnostics(undefined, `token ${token} rejected`);
    expect(d.body_snippet).toBeDefined();
    expect(d.body_snippet).not.toContain(token);
    expect(d.body_snippet).toContain("***REDACTED:pat***");
  });
});

describe("buildProbeDiagnostics — header allowlist", () => {
  test("keeps exact-allowlisted headers, lowercases keys, drops the rest", () => {
    const d = buildProbeDiagnostics(
      {
        "WWW-Authenticate": 'OAuth realm="https://example.test"',
        "Content-Type": "application/json",
        "set-cookie": "session=secret-cookie",
        "x-powered-by": "Express",
      },
      null,
    );
    expect(d.response_headers).toEqual({
      "www-authenticate": 'OAuth realm="https://example.test"',
      "content-type": "application/json",
    });
  });

  test("keeps x-* diagnostic headers via the pattern allowlist", () => {
    const d = buildProbeDiagnostics(
      {
        "X-Seraph-LoginReason": "AUTHENTICATED_FAILED",
        "x-request-id": "req-123",
        "x-cache": "HIT",
      },
      null,
    );
    expect(d.response_headers).toEqual({
      "x-seraph-loginreason": "AUTHENTICATED_FAILED",
      "x-request-id": "req-123",
    });
  });

  test("header values are scrubbed", () => {
    const d = buildProbeDiagnostics({ "www-authenticate": "Bearer abc.def.ghi" }, null);
    expect(d.response_headers?.["www-authenticate"]).toBe("***REDACTED:bearer***");
  });

  test("response_headers omitted when no header survives", () => {
    const d = buildProbeDiagnostics({ "set-cookie": "a=1", server: "nginx" }, null);
    expect(d.response_headers).toBeUndefined();
  });

  test("returns {} when both inputs are empty (safe to spread)", () => {
    expect(buildProbeDiagnostics(undefined, null)).toEqual({});
    expect(buildProbeDiagnostics({}, undefined)).toEqual({});
  });
});
