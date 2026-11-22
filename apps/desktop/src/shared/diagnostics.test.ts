import { describe, expect, test } from "bun:test";
import {
  appendError,
  buildDiagnostics,
  type DiagnosticsInput,
  parseCodesign,
} from "./diagnostics.ts";

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

  test("masks Linux drive paths, local phone numbers and links without a scheme", () => {
    const [entry] = appendError([], {
      at: "2026-11-20T10:00:00.000Z",
      scope: "files",
      message:
        "copy /media/alex/Backup/notes.txt failed, call 030 12345678 or open intranet.example.com/hr/alex?id=7",
    });
    expect(entry?.message).not.toContain("alex");
    expect(entry?.message).not.toContain("12345678");
    expect(entry?.message).toContain("intranet.example.com/");
  });

  test("keeps versions, dates and ports in diagnostic text", () => {
    const message = "version 0.1.0 at 2026-11-20 on :8080 after 12345 bytes, see report.pdf";
    expect(appendError([], { at: "x", scope: "s", message })[0]?.message).toBe(message);
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

  const SECRET = "Zx9ruJ7-pQ2vW4mN8sT1aB6c";
  const base: DiagnosticsInput = {
    appVersion: "12.1.2",
    electronVersion: "45.4.1",
    chromeVersion: "150.0.0.0",
    platform: "darwin",
    osRelease: "27.0.0",
    arch: "arm64",
    locale: "de-DE",
    packaged: true,
    serverOrigin: null,
    serverVersion: null,
    connection: "offline",
    profileCount: 0,
    errors: [],
    generatedAt: "2026-11-22T10:05:00.000Z",
  };

  test("assembles signing, status, permissions, crashes and the log tail", () => {
    const bundle = buildDiagnostics({
      ...base,
      signing: {
        signed: true,
        authority: "Developer ID Application",
        team: "ABCDE12345",
        notarized: true,
      },
      logTail: Array.from({ length: 250 }, (_, i) => `line ${i}`),
      crashes: [
        { at: base.generatedAt, source: "gpu", process: "GPU", reason: "crashed", exitCode: 9 },
      ],
      minidumps: 2,
      local: { configured: true, phase: "failed", error: "downgrade_refused", engineLog: ["boot"] },
      runner: "crashed",
      permissions: { accessibility: "granted", screen: "missing" },
    });
    expect(bundle.schema).toBe("subkit-desktop-diagnostics.v2");
    expect(bundle.signing?.team).toBe("ABCDE12345");
    expect(bundle.log).toHaveLength(200);
    expect(bundle.log[0]).toBe("line 50");
    expect(bundle.crashes).toEqual([
      { at: base.generatedAt, source: "gpu", process: "GPU", reason: "crashed", exit_code: 9 },
    ]);
    expect(bundle.minidumps).toBe(2);
    expect(bundle.local).toEqual({
      configured: true,
      phase: "failed",
      error: "downgrade_refused",
      engine_log: ["boot"],
    });
    expect(bundle.runner).toBe("crashed");
    expect(bundle.permissions).toEqual({ accessibility: "granted", screen: "missing" });
  });

  test("redacts secrets from log lines, engine log, crashes and errors", () => {
    const leak = `DATABASE_URL=postgres://subkit:${SECRET}@127.0.0.1/subkit token=${SECRET}`;
    const bundle = buildDiagnostics(
      {
        ...base,
        logTail: [
          leak,
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
          "/Users/mike/x.log",
        ],
        local: { configured: true, phase: "failed", error: leak, engineLog: [leak] },
        crashes: [
          {
            at: base.generatedAt,
            source: "renderer",
            process: `app://x?k=${SECRET}`,
            reason: "oom",
            exitCode: null,
          },
        ],
        errors: [{ at: base.generatedAt, scope: "local", message: leak }],
        secrets: [SECRET],
      },
      "/Users/mike",
    );
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toContain("/Users/mike");
  });

  test("reads the codesign summary", () => {
    const output = [
      "Executable=/Applications/SubKit.app/Contents/MacOS/SubKit",
      "Authority=Developer ID Application: Example (ABCDE12345)",
      "Authority=Developer ID Certification Authority",
      "Notarization Ticket=stapled",
      "TeamIdentifier=ABCDE12345",
    ].join("\n");
    expect(parseCodesign(output, 0)).toEqual({
      signed: true,
      authority: "Developer ID Application: Example (ABCDE12345)",
      team: "ABCDE12345",
      notarized: true,
    });
    expect(parseCodesign("code object is not signed at all", 1)).toEqual({
      signed: false,
      authority: null,
      team: null,
      notarized: null,
    });
    expect(parseCodesign("Signature=adhoc\nTeamIdentifier=not set", 0).team).toBeNull();
  });
});
