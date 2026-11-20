import { describe, expect, test } from "bun:test";
import { appendError, buildDiagnostics, redactText, redactUrl } from "./redaction.ts";

describe("redaction", () => {
  test("keeps only the origin of a URL", () => {
    expect(redactUrl("https://subkit.example.com/cockpit/i/abc/workflows/7?token=s3cret#x")).toBe(
      "https://subkit.example.com/[redacted]",
    );
    expect(redactUrl("https://subkit.example.com/")).toBe("https://subkit.example.com");
    expect(redactUrl("subkit://callback?code=abcdefgh&state=ijklmnop")).toBe("subkit://[redacted]");
    expect(redactUrl("nonsense")).toBe("[redacted]");
  });

  test("removes URL paths and query strings inside text", () => {
    const out = redactText(
      "fetch https://subkit.example.com/v1/identity/desktop-session?code=abc123 failed",
    );
    expect(out).toBe("fetch https://subkit.example.com/[redacted] failed");
  });

  test("removes tokens, keys, cookies and named secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const out = redactText(
      `Authorization: Bearer abc.def-123 cookie=subkit_session_value jwt ${jwt} key sk_live_abcdef123456 code_verifier="v3rifier" password: hunter2`,
    );
    for (const secret of [
      "abc.def-123",
      "subkit_session_value",
      jwt,
      "sk_live_abcdef123456",
      "v3rifier",
      "hunter2",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  test("removes email addresses and the home directory", () => {
    expect(redactText("user mike@example.com at /Users/mike/Library/x", "/Users/mike")).toBe(
      "user [email] at ~/Library/x",
    );
  });

  test("keeps the last 10 errors, redacted and bounded", () => {
    let log: ReturnType<typeof appendError> = [];
    for (let i = 0; i < 14; i++) {
      log = appendError(log, {
        at: `2026-11-20T10:00:${String(i).padStart(2, "0")}.000Z`,
        scope: "events.stream",
        message: `attempt ${i} at https://subkit.example.com/v1/x?token=t${i} ${"y".repeat(900)}`,
      });
    }
    expect(log).toHaveLength(10);
    expect(log[0]?.message.startsWith("attempt 4 at https://subkit.example.com/[redacted]")).toBe(
      true,
    );
    expect(log.every((entry) => entry.message.length <= 500)).toBe(true);
  });

  test("builds a diagnostics bundle without paths, queries or secrets", () => {
    const bundle = buildDiagnostics(
      {
        appVersion: "0.1.0",
        electronVersion: "45.4.1",
        chromeVersion: "150.0.0.0",
        platform: "darwin",
        osRelease: "27.0.0",
        arch: "arm64",
        locale: "de-DE",
        packaged: true,
        serverOrigin: "https://subkit.example.com",
        serverVersion: "11.2.0",
        connection: "online",
        profileCount: 2,
        errors: [
          {
            at: "2026-11-20T10:00:00.000Z",
            scope: "login",
            message: "POST https://subkit.example.com/v1/identity/desktop-session?code=zzz 500",
          },
        ],
        generatedAt: "2026-11-20T10:05:00.000Z",
      },
      "/Users/mike",
    );
    const text = JSON.stringify(bundle);
    expect(bundle.app.version).toBe("0.1.0");
    expect(bundle.server).toEqual({
      origin: "https://subkit.example.com",
      version: "11.2.0",
      connection: "online",
    });
    expect(bundle.errors).toHaveLength(1);
    expect(text).not.toContain("desktop-session");
    expect(text).not.toContain("zzz");
  });
});
