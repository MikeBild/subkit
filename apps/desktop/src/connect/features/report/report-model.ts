import type { Locale, MessageKey } from "../../../shared/i18n.ts";
import type { ReportFailure, ReportView } from "../../../shared/problem-report.ts";

export interface ReportNotice {
  tone: "success" | "warning" | "danger";
  title: MessageKey;
  body: MessageKey;
  vars: Record<string, string>;
  reference: { label: MessageKey; value: string } | null;
}

export interface ReportModel {
  lead: { key: MessageKey; vars: Record<string, string> } | null;
  form: boolean;
  sending: boolean;
  send: MessageKey | null;
  notice: ReportNotice | null;
  close: MessageKey;
}

const WARNINGS = new Set<ReportFailure>(["rate_limited", "unavailable", "no_server"]);

function clock(seconds: number, now: number, locale: Locale): string {
  return new Date(now + seconds * 1000).toLocaleTimeString(locale === "de" ? "de-DE" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function failureNotice(
  report: ReportView,
  failure: ReportFailure,
  now: number,
  locale: Locale,
): ReportNotice {
  const host = report.host ?? "";
  const waiting = failure === "rate_limited" && report.retryAfter !== null;
  return {
    tone: WARNINGS.has(failure) ? "warning" : "danger",
    title: `report.${failure}`,
    body: waiting ? "report.rate_limited.until" : `report.${failure}.detail`,
    vars: {
      host,
      ...(waiting && report.retryAfter !== null
        ? { time: clock(report.retryAfter, now, locale) }
        : {}),
    },
    reference: report.reference ? { label: "report.trace", value: report.reference } : null,
  };
}

export function reportModel(
  report: ReportView,
  locale: Locale,
  now: number = Date.now(),
): ReportModel {
  const host = report.host;
  const sent = report.phase === "sent";
  const notice: ReportNotice | null = sent
    ? {
        tone: "success",
        title: "report.sent",
        body: "report.sent.detail",
        vars: { host: host ?? "" },
        reference: report.reference ? { label: "report.reference", value: report.reference } : null,
      }
    : report.phase === "failed" && report.failure
      ? failureNotice(report, report.failure, now, locale)
      : null;
  return {
    lead: host
      ? { key: report.signedIn ? "report.lead.signedIn" : "report.lead", vars: { host } }
      : null,
    form: !sent && host !== null,
    sending: report.phase === "sending",
    send: sent || host === null ? null : report.phase === "failed" ? "report.retry" : "report.send",
    notice,
    close: sent ? "report.close" : "report.cancel",
  };
}
