import { redactDiagnosticText, redactKnownValues, redactUrl } from "@shared/redaction.ts";
import type { CrashEntry } from "./crashes.ts";

export const KNOWN_SECRET_MIN = 8;

export function redactKnown(text: string, secrets: readonly string[]): string {
  return redactKnownValues(
    text,
    secrets.filter((secret) => secret.length >= KNOWN_SECRET_MIN),
  );
}

export interface ErrorEntry {
  at: string;
  scope: string;
  message: string;
}

export const ERROR_LOG_LIMIT = 10;

export function appendError(
  log: readonly ErrorEntry[],
  entry: ErrorEntry,
  homeDir?: string,
): ErrorEntry[] {
  const clean: ErrorEntry = {
    at: entry.at,
    scope: redactDiagnosticText(entry.scope, { homeDir }).slice(0, 80),
    message: redactDiagnosticText(entry.message, { homeDir }).slice(0, 500),
  };
  return [...log, clean].slice(-ERROR_LOG_LIMIT);
}

export interface DiagnosticsInput {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
  locale: string;
  packaged: boolean;
  serverOrigin: string | null;
  serverVersion: string | null;
  connection: string;
  profileCount: number;
  errors: readonly ErrorEntry[];
  generatedAt: string;
  signing?: SigningInfo | undefined;
  logTail?: readonly string[] | undefined;
  crashes?: readonly CrashEntry[] | undefined;
  minidumps?: number | undefined;
  local?: LocalStatus | undefined;
  runner?: string | null | undefined;
  permissions?: Readonly<Record<string, string>> | undefined;
  secrets?: readonly string[] | undefined;
}

export interface SigningInfo {
  signed: boolean;
  authority: string | null;
  team: string | null;
  notarized: boolean | null;
}

export interface LocalStatus {
  configured: boolean;
  phase: string;
  error: string | null;
  engineLog: readonly string[];
}

export const BUNDLE_LOG_LINES = 200;
export const BUNDLE_ENGINE_LINES = 60;

export function parseCodesign(output: string, status: number | null): SigningInfo {
  if (status !== 0) return { signed: false, authority: null, team: null, notarized: null };
  const value = (name: string) =>
    output
      .split("\n")
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim() ?? null;
  const team = value("TeamIdentifier");
  return {
    signed: true,
    authority: value("Authority"),
    team: team === "not set" ? null : team,
    notarized: /Notarization Ticket=stapled/.test(output) ? true : null,
  };
}

export interface RedactContext {
  secrets: readonly string[];
  homeDir?: string | undefined;
}

export function redactLogText(text: string, context: RedactContext): string {
  return redactDiagnosticText(redactKnown(text, context.secrets), { homeDir: context.homeDir });
}

export type DesktopDiagnostics = ReturnType<typeof buildDiagnostics>;

export function buildDiagnostics(input: DiagnosticsInput, homeDir?: string) {
  const secrets = input.secrets ?? [];
  const text = (value: string) => redactLogText(value, { secrets, homeDir });
  return {
    schema: "subkit-desktop-diagnostics.v2",
    generated_at: input.generatedAt,
    app: { version: input.appVersion, packaged: input.packaged, locale: input.locale },
    runtime: { electron: input.electronVersion, chrome: input.chromeVersion },
    os: { platform: input.platform, release: input.osRelease, arch: input.arch },
    server: {
      origin: input.serverOrigin ? redactUrl(input.serverOrigin) : null,
      version: input.serverVersion,
      connection: input.connection,
    },
    signing: input.signing ?? null,
    profiles: input.profileCount,
    local: input.local
      ? {
          configured: input.local.configured,
          phase: input.local.phase,
          error: input.local.error === null ? null : text(input.local.error),
          engine_log: input.local.engineLog.slice(-BUNDLE_ENGINE_LINES).map(text),
        }
      : null,
    runner: input.runner ?? null,
    permissions: input.permissions ?? {},
    errors: input.errors.slice(-ERROR_LOG_LIMIT).map((entry) => ({
      at: entry.at,
      scope: text(entry.scope),
      message: text(entry.message),
    })),
    crashes: (input.crashes ?? []).map((crash) => ({
      at: crash.at,
      source: crash.source,
      process: text(crash.process),
      reason: crash.reason,
      exit_code: crash.exitCode,
    })),
    minidumps: input.minidumps ?? 0,
    log: (input.logTail ?? []).slice(-BUNDLE_LOG_LINES).map(text),
  };
}
