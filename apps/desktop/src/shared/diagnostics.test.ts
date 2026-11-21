import { describe, expect, test } from "bun:test";
import { appendError, buildDiagnostics } from "./diagnostics.ts";

describe("diagnostics", () => {
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
    expect(
      log[0]?.message.startsWith("attempt 4 at https://subkit.example.com/***redacted***"),
    ).toBe(true);
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
