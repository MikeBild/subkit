import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { Locale, MessageKey } from "./i18n.ts";
import type { Profile } from "./profiles.ts";

export const FEEDBACK_PATH = "/v1/feedback";
export const REPORT_MESSAGE_MAX = 5000;
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const DIAGNOSTICS_FILENAME = "subkit-desktop-diagnostics.json";

export type ReportFailure =
  | "no_server"
  | "unavailable"
  | "rate_limited"
  | "refused"
  | "offline"
  | "failed";

export type ReportPhase = "editing" | "sending" | "sent" | "failed";

export interface ReportFact {
  label: MessageKey;
  value: string;
}

export interface ReportView {
  phase: ReportPhase;
  host: string | null;
  signedIn: boolean;
  attachDefault: boolean;
  preview: ReportFact[];
  reference: string | null;
  failure: ReportFailure | null;
  retryAfter: number | null;
}

export const CLOSED_REPORT: ReportView = {
  phase: "editing",
  host: null,
  signedIn: false,
  attachDefault: true,
  preview: [],
  reference: null,
  failure: null,
  retryAfter: null,
};

const FALLBACK_MESSAGE: Record<Locale, string> = {
  de: "Fehlermeldung aus SubKit Desktop ohne Beschreibung.",
  en: "Problem report from SubKit Desktop without a description.",
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

export interface ReportDiagnostics {
  client_kind: "desktop";
  app_version?: string;
  platform?: string;
  server_version?: string;
  connection?: string;
  recent_errors?: { code: string; at: string }[];
}

export interface ReportBody {
  client_request_id: string;
  kind: "bug";
  message: string;
  device_id?: string;
  diagnostics: ReportDiagnostics;
  attachments?: { filename: string; content_base64: string }[];
}

export function reportPreview(bundle: DesktopDiagnostics): ReportFact[] {
  return [
    { label: "report.fact.app", value: bundle.app.version },
    { label: "report.fact.system", value: `${bundle.os.platform} ${bundle.os.release}` },
    { label: "report.fact.server", value: bundle.server.version ?? "–" },
    { label: "report.fact.errors", value: String(bundle.errors.length + bundle.crashes.length) },
    { label: "report.fact.log", value: String(bundle.log.length) },
  ];
}

function summary(bundle: DesktopDiagnostics): ReportDiagnostics {
  const fields = {
    app_version: short(bundle.app.version),
    platform: short(`${bundle.os.platform} ${bundle.os.release} ${bundle.os.arch}`),
    server_version: short(bundle.server.version),
    connection: short(bundle.server.connection),
  };
  return {
    client_kind: "desktop",
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    recent_errors: [
      ...bundle.errors.map((entry) => ({ text: `${entry.scope}: ${entry.message}`, at: entry.at })),
      ...bundle.crashes.map((crash) => ({
        text: `crash.${crash.source}: ${crash.process} ${crash.reason} exit ${crash.exit_code ?? "-"}`,
        at: crash.at,
      })),
    ]
      .filter((entry) => validTime(entry.at))
      .sort((left, right) => left.at.localeCompare(right.at))
      .slice(-10)
      .map((entry) => ({ code: short(entry.text, CODE_MAX) ?? "error", at: entry.at })),
  };
}

function encoded(bundle: DesktopDiagnostics): Buffer {
  return Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

export function diagnosticsFile(bundle: DesktopDiagnostics): string {
  let fitted = bundle;
  let bytes = encoded(fitted);
  while (bytes.byteLength > ATTACHMENT_MAX_BYTES && fitted.log.length > 0) {
    fitted = { ...fitted, log: fitted.log.slice(Math.ceil(fitted.log.length / 2)) };
    bytes = encoded(fitted);
  }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) bytes = encoded({ ...fitted, local: null, log: [] });
  return bytes.toString("base64");
}

export function reportBody(input: {
  bundle: DesktopDiagnostics;
  message: string;
  attach: boolean;
  locale: Locale;
  reportId: string;
  deviceId?: string | undefined;
}): ReportBody {
  const message = input.message.trim().slice(0, REPORT_MESSAGE_MAX);
  return {
    client_request_id: input.reportId,
    kind: "bug",
    message: message || FALLBACK_MESSAGE[input.locale],
    ...(input.deviceId ? { device_id: input.deviceId } : {}),
    diagnostics: input.attach ? summary(input.bundle) : { client_kind: "desktop" },
    ...(input.attach
      ? {
          attachments: [
            { filename: DIAGNOSTICS_FILENAME, content_base64: diagnosticsFile(input.bundle) },
          ],
        }
      : {}),
  };
}

export interface ReportAnswer {
  status: number;
  json: unknown;
  traceId: string | null;
}

export type ReportOutcome =
  | { ok: true; reference: string }
  | { ok: false; failure: ReportFailure; reference: string | null; retryAfter: number | null };

function field(json: unknown, key: string): unknown {
  return json && typeof json === "object" ? (json as Record<string, unknown>)[key] : undefined;
}

function failureOf(status: number): ReportFailure {
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status === 400 || status === 413 || status === 422) return "refused";
  return "failed";
}

export function reportOutcome(answer: ReportAnswer | null): ReportOutcome {
  if (!answer) return { ok: false, failure: "offline", reference: null, retryAfter: null };
  const id = field(answer.json, "id");
  if ((answer.status === 200 || answer.status === 201) && typeof id === "string")
    return { ok: true, reference: id };
  const trace = field(answer.json, "trace_id");
  const retry = field(answer.json, "retry_after");
  return {
    ok: false,
    failure: failureOf(answer.status),
    reference: typeof trace === "string" && trace ? trace : answer.traceId,
    retryAfter: typeof retry === "number" && retry > 0 ? Math.ceil(retry) : null,
  };
}

export interface ReportTarget {
  origin: string;
  signedIn: boolean;
  deviceId: string | undefined;
}

export function reportTarget(
  profile: Profile | null,
  fallback: string | null,
): ReportTarget | null {
  if (profile)
    return {
      origin: profile.serverOrigin,
      signedIn: Boolean(profile.installationId && profile.cockpitPath),
      deviceId: profile.deviceId,
    };
  return fallback ? { origin: fallback, signedIn: false, deviceId: undefined } : null;
}

export interface ReportPorts {
  signed: ((body: ReportBody) => Promise<ReportAnswer | null>) | null;
  anonymousPath: (origin: string) => Promise<{ reachable: boolean; path: string | null }>;
  anonymous: (origin: string, path: string, body: ReportBody) => Promise<ReportAnswer | null>;
}

export async function deliverReport(
  target: ReportTarget,
  body: ReportBody,
  ports: ReportPorts,
): Promise<ReportAnswer | null> {
  if (target.signedIn && ports.signed) {
    const { device_id: _device, ...signed } = body;
    const answer = await ports.signed(signed).catch(() => null);
    if (answer && answer.status !== 401) return answer;
  }
  const found = await ports.anonymousPath(target.origin);
  if (!found.reachable) return null;
  if (!found.path) return { status: 503, json: null, traceId: null };
  return ports.anonymous(target.origin, found.path, body);
}
