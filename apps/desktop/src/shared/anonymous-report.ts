import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { Locale } from "./i18n.ts";

export type AnonymousReportOutcome = "sent" | "rate_limited" | "refused" | "unavailable" | "failed";

const MESSAGE: Record<Locale, string> = {
  de: "Fehlermeldung aus SubKit Desktop vor der Anmeldung. Die Diagnosedaten hängen an.",
  en: "Problem report from SubKit Desktop before sign-in. The diagnostics are attached.",
};

const TEXT_MAX = 200;
const CODE_MAX = 300;

function short(value: string | null | undefined, max = TEXT_MAX): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function validTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
}

export interface AnonymousReportBody {
  client_request_id: string;
  kind: "bug";
  message: string;
  device_id: string;
  diagnostics: {
    client_kind: "desktop";
    app_version?: string;
    platform?: string;
    server_version?: string;
    connection?: string;
    recent_errors: { code: string; at: string }[];
  };
}

export function anonymousReportBody(input: {
  bundle: DesktopDiagnostics;
  deviceId: string;
  locale: Locale;
  reportId: string;
}): AnonymousReportBody {
  const { bundle } = input;
  const fields = {
    app_version: short(bundle.app.version),
    platform: short(`${bundle.os.platform} ${bundle.os.release} ${bundle.os.arch}`),
    server_version: short(bundle.server.version),
    connection: short(bundle.server.connection),
  };
  return {
    client_request_id: input.reportId,
    kind: "bug",
    message: MESSAGE[input.locale],
    device_id: input.deviceId,
    diagnostics: {
      client_kind: "desktop",
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      recent_errors: [
        ...bundle.errors.map((entry) => ({
          text: `${entry.scope}: ${entry.message}`,
          at: entry.at,
        })),
        ...bundle.crashes.map((crash) => ({
          text: `crash.${crash.source}: ${crash.process} ${crash.reason} exit ${crash.exit_code ?? "-"}`,
          at: crash.at,
        })),
      ]
        .filter((entry) => validTime(entry.at))
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(-10)
        .map((entry) => ({ code: short(entry.text, CODE_MAX) ?? "error", at: entry.at })),
    },
  };
}

export function anonymousReportOutcome(status: number | null): AnonymousReportOutcome {
  if (status === 201) return "sent";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status === 400 || status === 413 || status === 422) return "refused";
  return "failed";
}
