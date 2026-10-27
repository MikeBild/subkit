import { expect, test } from "bun:test";
import { diagnosticProjection } from "./diagnostic-projection.ts";

test("removes secret containers and authentication identifiers while preserving context", () => {
  const projected = diagnosticProjection({
    messages: [{ role: "user", content: "Der Entwurf lässt sich nicht speichern" }],
    credentials: { arbitrary: "hidden-value" },
    authorization: ["hidden-value"],
    auth_source: { kind: "browser_session", session_id: "hidden-session" },
    sessionId: "hidden-session",
    headers: { Cookie: "hidden-cookie", "X-Request-Id": "request-42" },
    input: { apiKey: { value: "hidden-key" }, count: 3 },
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain("hidden-");
  expect(serialized).toContain("Der Entwurf lässt sich nicht speichern");
  expect(serialized).toContain("request-42");
  expect(projected.input).toEqual({ apiKey: "[redacted]", count: 3 });
});

test("removes known secrets embedded in text and keeps repeated nonsensitive objects", () => {
  const shared = { status: "failed" };
  const projected = diagnosticProjection(
    {
      message: "request used opaque-private-value and opaque-private-value-long",
      first: shared,
      second: shared,
    },
    ["opaque-private-value", "opaque-private-value-long"],
  );
  expect(projected).toEqual({
    message: "request used [redacted] and [redacted]",
    first: shared,
    second: shared,
  });
});

test("bounds recursive data and preserves timestamp values", () => {
  const circular: Record<string, unknown> = { at: new Date("2026-01-01T00:00:00Z") };
  circular.self = circular;
  expect(diagnosticProjection(circular)).toEqual({
    at: "2026-01-01T00:00:00.000Z",
    self: "[circular]",
  });
});

test("redacts named header values and credentials embedded in URLs", () => {
  const result = diagnosticProjection({
    headers: [
      { name: "Authorization", value: "hidden-auth" },
      { key: "Cookie", value: ["hidden-cookie"] },
    ],
    url: "https://hidden-user:hidden-password@example.test/path?api_key=hidden-key&limit=5",
    access_url: "https://example.test/portal#access=hidden-capability",
  });
  expect(JSON.stringify(result)).not.toContain("hidden-");
  expect(JSON.stringify(result)).toContain("limit=5");
});

test("keeps numeric usage metrics and excludes encrypted execution payloads", () => {
  expect(
    diagnosticProjection({
      tokens_in: 12,
      tokens_out: 5,
      total_tokens: 17,
      token: "hidden-token",
      output: {
        $sensitive: true,
        ciphertext: "hidden-ciphertext",
        iv: "hidden-iv",
        auth_tag: "hidden-tag",
      },
    }),
  ).toEqual({
    tokens_in: 12,
    tokens_out: 5,
    total_tokens: 17,
    token: "[redacted]",
    output: "[protected-execution-data]",
  });
});
