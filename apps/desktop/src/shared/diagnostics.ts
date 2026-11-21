import { redactDiagnosticText, redactKnownValues, redactUrl } from "@shared/redaction.ts";

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
}

export type DesktopDiagnostics = ReturnType<typeof buildDiagnostics>;

export function buildDiagnostics(input: DiagnosticsInput, homeDir?: string) {
  return {
    schema: "subkit-desktop-diagnostics.v1",
    generated_at: input.generatedAt,
    app: { version: input.appVersion, packaged: input.packaged, locale: input.locale },
    runtime: { electron: input.electronVersion, chrome: input.chromeVersion },
    os: { platform: input.platform, release: input.osRelease, arch: input.arch },
    server: {
      origin: input.serverOrigin ? redactUrl(input.serverOrigin) : null,
      version: input.serverVersion,
      connection: input.connection,
    },
    profiles: input.profileCount,
    errors: input.errors.slice(-ERROR_LOG_LIMIT).map((entry) => ({
      at: entry.at,
      scope: redactDiagnosticText(entry.scope, { homeDir }),
      message: redactDiagnosticText(entry.message, { homeDir }),
    })),
  };
}
