import { describe, expect, test } from "bun:test";
import { redact } from "./redact.ts";

describe("redact", () => {
  test("redacts case-insensitive denylist keys", () => {
    const input = {
      Authorization: "Bearer abc123",
      password: "hunter2",
      token: "xoxb-123",
      nested: { Cookie: "session=abc" },
      safe: "ok",
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.Authorization).toBe("***redacted***");
    expect(out.password).toBe("***redacted***");
    expect(out.token).toBe("***redacted***");
    expect((out.nested as Record<string, unknown>).Cookie).toBe("***redacted***");
    expect(out.safe).toBe("ok");
  });

  test("scrubs bearer tokens in free-form strings", () => {
    const input = { note: "use Bearer xyz123 to call" };
    const out = redact(input) as Record<string, unknown>;
    expect(out.note).not.toContain("xyz123");
  });

  test("scrubs wf_live_ api keys in free-form strings", () => {
    const input = { hint: "try wf_live_abc123def456 to auth" };
    const out = redact(input) as Record<string, unknown>;
    expect(out.hint).not.toContain("wf_live_abc123def456");
  });
});
