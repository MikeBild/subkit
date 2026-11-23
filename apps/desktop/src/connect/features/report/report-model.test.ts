import { describe, expect, test } from "bun:test";
import { dictionary, type MessageKey, messageKeys } from "../../../shared/i18n.ts";
import {
  CLOSED_REPORT,
  type ReportFailure,
  type ReportView,
} from "../../../shared/problem-report.ts";
import { reportModel } from "./report-model.ts";

const OPEN: ReportView = { ...CLOSED_REPORT, host: "subkit-cloud.example" };
const NOON = Date.UTC(2026, 10, 23, 12, 0, 0);
const FAILURES: ReportFailure[] = [
  "no_server",
  "unavailable",
  "rate_limited",
  "refused",
  "offline",
  "failed",
];

describe("report screen model", () => {
  test("an open report names the server and offers Send and Cancel", () => {
    expect(reportModel(OPEN, "en", NOON)).toEqual({
      lead: { key: "report.lead", vars: { host: "subkit-cloud.example" } },
      form: true,
      sending: false,
      send: "report.send",
      notice: null,
      close: "report.cancel",
    });
    expect(reportModel({ ...OPEN, signedIn: true }, "en", NOON).lead?.key).toBe(
      "report.lead.signedIn",
    );
  });

  test("sending keeps the form and marks Send as busy", () => {
    expect(reportModel({ ...OPEN, phase: "sending" }, "en", NOON)).toMatchObject({
      form: true,
      sending: true,
      send: "report.send",
    });
  });

  test("a sent report shows the id, hides the form and Send, and offers Close", () => {
    expect(reportModel({ ...OPEN, phase: "sent", reference: "r1" }, "en", NOON)).toEqual({
      lead: { key: "report.lead", vars: { host: "subkit-cloud.example" } },
      form: false,
      sending: false,
      send: null,
      notice: {
        tone: "success",
        title: "report.sent",
        body: "report.sent.detail",
        vars: { host: "subkit-cloud.example" },
        reference: { label: "report.reference", value: "r1" },
      },
      close: "report.close",
    });
  });

  test("a failure explains itself, names the trace id and offers Send again", () => {
    const model = reportModel(
      { ...OPEN, phase: "failed", failure: "offline", reference: "t9" },
      "en",
      NOON,
    );
    expect(model.send).toBe("report.retry");
    expect(model.form).toBe(true);
    expect(model.notice).toEqual({
      tone: "danger",
      title: "report.offline",
      body: "report.offline.detail",
      vars: { host: "subkit-cloud.example" },
      reference: { label: "report.trace", value: "t9" },
    });
  });

  test("a rate limit with a wait names the time to try again", () => {
    const model = reportModel(
      { ...OPEN, phase: "failed", failure: "rate_limited", retryAfter: 600 },
      "de",
      NOON,
    );
    expect(model.notice?.tone).toBe("warning");
    expect(model.notice?.body).toBe("report.rate_limited.until");
    expect(model.notice?.vars.time).toMatch(/^\d{2}:\d{2}$/);
  });

  test("without a server there is no form and no Send, only the message", () => {
    const model = reportModel(
      { ...CLOSED_REPORT, phase: "failed", failure: "no_server" },
      "en",
      NOON,
    );
    expect(model).toMatchObject({ lead: null, form: false, send: null });
    expect(model.notice?.title).toBe("report.no_server");
  });

  test("every key the screen can show exists in German and English", () => {
    const keys = new Set<MessageKey>(messageKeys());
    const used: MessageKey[] = ["report.title", "report.description", "report.attach"];
    for (const failure of FAILURES) {
      const notice = reportModel(
        { ...OPEN, phase: "failed", failure, retryAfter: 60 },
        "en",
        NOON,
      ).notice;
      if (notice) used.push(notice.title, notice.body);
    }
    for (const key of used) {
      expect(keys.has(key)).toBe(true);
      expect(dictionary("de")[key]).not.toBe("");
      expect(dictionary("en")[key]).not.toBe("");
    }
  });
});
