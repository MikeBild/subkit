import { describe, expect, test } from "bun:test";
import { anonymousReportBody, anonymousReportOutcome } from "./anonymous-report.ts";
import { buildDiagnostics } from "./diagnostics.ts";

const REPORT_ID = "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77";
const DEVICE = "9a1e5c7d-2b4f-4e6a-8c0d-1f3b5d7e9a2c";

function bundle(overrides: Partial<Parameters<typeof buildDiagnostics>[0]> = {}) {
  return buildDiagnostics({
    appVersion: "1.2.0",
    electronVersion: "45.0.0",
    chromeVersion: "140.0",
    platform: "darwin",
    osRelease: "25.0.0",
    arch: "arm64",
    locale: "de-DE",
    packaged: true,
    serverOrigin: "https://subkit.example.test",
    serverVersion: "12.1.0",
    connection: "signed-out",
    profileCount: 1,
    errors: [
      { at: "2026-11-20T10:00:00.000Z", scope: "login", message: "exchange failed" },
      { at: "not a time", scope: "feed", message: "dropped" },
    ],
    generatedAt: "2026-11-22T08:00:00.000Z",
    ...overrides,
  });
}

describe("anonymousReportBody", () => {
  test("sends the diagnostics with the device and a retryable report id", () => {
    expect(
      anonymousReportBody({
        bundle: bundle(),
        deviceId: DEVICE,
        locale: "en",
        reportId: REPORT_ID,
      }),
    ).toEqual({
      client_request_id: REPORT_ID,
      kind: "bug",
      message: "Problem report from SubKit Desktop before sign-in. The diagnostics are attached.",
      device_id: DEVICE,
      diagnostics: {
        client_kind: "desktop",
        app_version: "1.2.0",
        platform: "darwin 25.0.0 arm64",
        server_version: "12.1.0",
        connection: "signed-out",
        recent_errors: [{ code: "login: exchange failed", at: "2026-11-20T10:00:00.000Z" }],
      },
    });
  });

  test("lists crashes next to errors in time order", () => {
    const body = anonymousReportBody({
      bundle: bundle({
        crashes: [
          {
            at: "2026-11-19T10:00:00.000Z",
            source: "gpu",
            process: "GPU",
            reason: "crashed",
            exitCode: 9,
          },
        ],
      }),
      deviceId: DEVICE,
      locale: "en",
      reportId: REPORT_ID,
    });
    expect(body.diagnostics.recent_errors).toEqual([
      { code: "crash.gpu: GPU crashed exit 9", at: "2026-11-19T10:00:00.000Z" },
      { code: "login: exchange failed", at: "2026-11-20T10:00:00.000Z" },
    ]);
  });

  test("writes the message in German and leaves out what the app does not know", () => {
    const body = anonymousReportBody({
      bundle: bundle({ serverVersion: null, connection: " ", errors: [] }),
      deviceId: DEVICE,
      locale: "de",
      reportId: REPORT_ID,
    });
    expect(body.message).toBe(
      "Fehlermeldung aus SubKit Desktop vor der Anmeldung. Die Diagnosedaten hängen an.",
    );
    expect(body.diagnostics).toEqual({
      client_kind: "desktop",
      app_version: "1.2.0",
      platform: "darwin 25.0.0 arm64",
      recent_errors: [],
    });
  });

  test("keeps every error code within the server's limit", () => {
    const body = anonymousReportBody({
      bundle: bundle({
        errors: [{ at: "2026-11-20T10:00:00Z", scope: "x", message: "y".repeat(600) }],
      }),
      deviceId: DEVICE,
      locale: "en",
      reportId: REPORT_ID,
    });
    expect(body.diagnostics.recent_errors[0]?.code.length).toBe(300);
  });
});

describe("anonymousReportOutcome", () => {
  test("names what happened for every answer", () => {
    expect(anonymousReportOutcome(201)).toBe("sent");
    expect(anonymousReportOutcome(429)).toBe("rate_limited");
    expect(anonymousReportOutcome(503)).toBe("unavailable");
    for (const status of [400, 413, 422]) expect(anonymousReportOutcome(status)).toBe("refused");
    for (const status of [null, 403, 500]) expect(anonymousReportOutcome(status)).toBe("failed");
  });
});
