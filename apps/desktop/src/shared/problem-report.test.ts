import { describe, expect, test } from "bun:test";
import { buildDiagnostics } from "./diagnostics.ts";
import {
  ATTACHMENT_MAX_BYTES,
  DIAGNOSTICS_FILENAME,
  deliverReport,
  diagnosticsFile,
  type ReportAnswer,
  type ReportBody,
  type ReportPorts,
  reportBody,
  reportOutcome,
  reportPreview,
  reportTarget,
} from "./problem-report.ts";
import { emptyStore, type Profile, upsertProfile } from "./profiles.ts";

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

function body(overrides: Partial<Parameters<typeof reportBody>[0]> = {}) {
  return reportBody({
    bundle: bundle(),
    message: "The sign-in window stays blank.",
    attach: true,
    locale: "en",
    reportId: REPORT_ID,
    deviceId: DEVICE,
    ...overrides,
  });
}

function decoded(content: string): unknown {
  return JSON.parse(Buffer.from(content, "base64").toString("utf8"));
}

describe("reportBody", () => {
  test("sends the description, the device, a retryable id and the full bundle as a file", () => {
    const sent = body();
    expect(sent).toMatchObject({
      client_request_id: REPORT_ID,
      kind: "bug",
      message: "The sign-in window stays blank.",
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
    expect(sent.attachments?.map((file) => file.filename)).toEqual([DIAGNOSTICS_FILENAME]);
    expect(decoded(sent.attachments?.[0]?.content_base64 ?? "")).toEqual(
      JSON.parse(JSON.stringify(bundle())),
    );
  });

  test("without diagnostics it sends only the description and the client kind", () => {
    const sent = body({ attach: false });
    expect(sent.diagnostics).toEqual({ client_kind: "desktop" });
    expect(sent.attachments).toBeUndefined();
  });

  test("leaves out the device when there is none", () => {
    expect("device_id" in body({ deviceId: undefined })).toBe(false);
  });

  test("an empty description becomes a short note in the person's language", () => {
    expect(body({ message: "   ", locale: "de" }).message).toBe(
      "Fehlermeldung aus SubKit Desktop ohne Beschreibung.",
    );
    expect(body({ message: "", locale: "en" }).message).toBe(
      "Problem report from SubKit Desktop without a description.",
    );
    expect(body({ message: "x".repeat(6000) }).message.length).toBe(5000);
  });

  test("lists crashes next to errors in time order", () => {
    const sent = body({
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
    });
    expect(sent.diagnostics.recent_errors).toEqual([
      { code: "crash.gpu: GPU crashed exit 9", at: "2026-11-19T10:00:00.000Z" },
      { code: "login: exchange failed", at: "2026-11-20T10:00:00.000Z" },
    ]);
  });

  test("leaves out what the app does not know", () => {
    const sent = body({ bundle: bundle({ serverVersion: null, connection: " ", errors: [] }) });
    expect(sent.diagnostics).toEqual({
      client_kind: "desktop",
      app_version: "1.2.0",
      platform: "darwin 25.0.0 arm64",
      recent_errors: [],
    });
  });

  test("keeps every error code within the server's limit", () => {
    const sent = body({
      bundle: bundle({
        errors: [{ at: "2026-11-20T10:00:00Z", scope: "x", message: "y".repeat(600) }],
      }),
    });
    expect(sent.diagnostics.recent_errors?.[0]?.code.length).toBe(300);
  });
});

describe("diagnosticsFile", () => {
  test("drops the oldest log lines until the file fits the server's attachment limit", () => {
    const huge = { ...bundle(), log: Array.from({ length: 200 }, () => "z".repeat(20_000)) };
    const file = Buffer.from(diagnosticsFile(huge), "base64");
    expect(file.byteLength).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
    const kept = JSON.parse(file.toString("utf8")) as { log: string[]; app: unknown };
    expect(kept.log.length).toBeGreaterThan(0);
    expect(kept.log.length).toBeLessThan(200);
    expect(kept.app).toEqual(huge.app);
  });
});

describe("reportPreview", () => {
  test("names what the diagnostics contain", () => {
    expect(reportPreview(bundle({ logTail: ["a", "b"] }))).toEqual([
      { label: "report.fact.app", value: "1.2.0" },
      { label: "report.fact.system", value: "darwin 25.0.0" },
      { label: "report.fact.server", value: "12.1.0" },
      { label: "report.fact.errors", value: "2" },
      { label: "report.fact.log", value: "2" },
    ]);
  });
});

describe("reportOutcome", () => {
  test("a filed report returns its id", () => {
    expect(reportOutcome({ status: 201, json: { id: "r1" }, traceId: "t1" })).toEqual({
      ok: true,
      reference: "r1",
    });
  });

  test("names what went wrong and keeps the trace id and the wait", () => {
    expect(
      reportOutcome({
        status: 429,
        json: { code: "rate_limit_exceeded", retry_after: 412.2, trace_id: "body-trace" },
        traceId: "header-trace",
      }),
    ).toEqual({ ok: false, failure: "rate_limited", reference: "body-trace", retryAfter: 413 });
    expect(reportOutcome({ status: 503, json: null, traceId: "h" })).toMatchObject({
      failure: "unavailable",
      reference: "h",
      retryAfter: null,
    });
    for (const status of [400, 413, 422])
      expect(reportOutcome({ status, json: {}, traceId: null })).toMatchObject({
        failure: "refused",
      });
    for (const status of [201, 403, 500])
      expect(reportOutcome({ status, json: {}, traceId: null })).toMatchObject({
        failure: "failed",
      });
    expect(reportOutcome(null)).toMatchObject({ failure: "offline", reference: null });
  });
});

describe("reportTarget", () => {
  const profile = (patch: Partial<Profile> = {}): Profile => ({
    ...(upsertProfile(emptyStore(), "https://work.example", {}, DEVICE).profiles[0] as Profile),
    ...patch,
  });

  test("a signed-in server gets the report under the sign-in", () => {
    expect(
      reportTarget(profile({ installationId: "i1", cockpitPath: "/" }), "https://cloud.example"),
    ).toEqual({ origin: "https://work.example", signedIn: true, deviceId: DEVICE });
  });

  test("a known server without sign-in gets it anonymously with the device", () => {
    expect(reportTarget(profile(), "https://cloud.example")).toEqual({
      origin: "https://work.example",
      signedIn: false,
      deviceId: DEVICE,
    });
  });

  test("before any server it goes to the default server, or nowhere", () => {
    expect(reportTarget(null, "https://cloud.example")).toEqual({
      origin: "https://cloud.example",
      signedIn: false,
      deviceId: undefined,
    });
    expect(reportTarget(null, null)).toBeNull();
  });
});

describe("deliverReport", () => {
  const sent: ReportAnswer = { status: 201, json: { id: "r1" }, traceId: null };
  const target = { origin: "https://work.example", signedIn: true, deviceId: DEVICE };
  const report = (): ReportBody => body();

  function ports(patch: Partial<ReportPorts> = {}) {
    const calls: string[] = [];
    const base: ReportPorts = {
      signed: async (payload) => {
        calls.push(`signed:${"device_id" in payload}`);
        return sent;
      },
      anonymousPath: async () => {
        calls.push("descriptor");
        return { reachable: true, path: "/v1/feedback/anonymous" };
      },
      anonymous: async (_origin, path, payload) => {
        calls.push(`anonymous:${path}:${payload.device_id}`);
        return sent;
      },
    };
    return { calls, ports: { ...base, ...patch } };
  }

  test("a signed-in report goes to the feedback endpoint without the device", async () => {
    const { calls, ports: p } = ports();
    expect(await deliverReport(target, report(), p)).toEqual(sent);
    expect(calls).toEqual(["signed:false"]);
  });

  test("an expired sign-in or a failed request falls back to the anonymous path", async () => {
    const expired = ports({
      signed: async () => ({ status: 401, json: null, traceId: null }),
    });
    await deliverReport(target, report(), expired.ports);
    expect(expired.calls).toEqual(["descriptor", `anonymous:/v1/feedback/anonymous:${DEVICE}`]);
    const broken = ports({ signed: async () => Promise.reject(new Error("csrf")) });
    await deliverReport(target, report(), broken.ports);
    expect(broken.calls).toEqual(["descriptor", `anonymous:/v1/feedback/anonymous:${DEVICE}`]);
  });

  test("a signed-in server error is shown, not resent anonymously", async () => {
    const failing = ports({ signed: async () => ({ status: 500, json: null, traceId: "t" }) });
    expect(await deliverReport(target, report(), failing.ports)).toMatchObject({ status: 500 });
    expect(failing.calls).toEqual([]);
  });

  test("an unreachable server is offline, one without the anonymous path unavailable", async () => {
    const anon = { ...target, signedIn: false };
    const offline = ports({ anonymousPath: async () => ({ reachable: false, path: null }) });
    expect(await deliverReport(anon, report(), offline.ports)).toBeNull();
    const closed = ports({ anonymousPath: async () => ({ reachable: true, path: null }) });
    expect(reportOutcome(await deliverReport(anon, report(), closed.ports))).toMatchObject({
      failure: "unavailable",
    });
    expect(closed.calls).toEqual([]);
  });
});
