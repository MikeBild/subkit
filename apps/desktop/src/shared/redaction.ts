const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>)\]}]+/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const API_KEY = /\bsk[_-][A-Za-z0-9_-]{8,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NAMED_SECRET =
  /\b(code_verifier|code_challenge|code|state|access_token|refresh_token|id_token|token|password|passwd|secret|api[_-]?key|set-cookie|cookie|authorization|session(?:_id)?)\b(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi;

export const REDACTED = "[redacted]";

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REDACTED;
  }
  if (
    url.protocol === "http:" ||
    url.protocol === "https:" ||
    url.protocol === "ws:" ||
    url.protocol === "wss:"
  ) {
    const detail = url.pathname !== "/" || url.search || url.hash;
    return `${url.protocol}//${url.host}${detail ? `/${REDACTED}` : ""}`;
  }
  return `${url.protocol}//${REDACTED}`;
}

export function redactText(text: string, homeDir?: string): string {
  let out = text.replace(URL_PATTERN, (match) => redactUrl(match));
  out = out.replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  out = out.replace(API_KEY, REDACTED);
  out = out.replace(
    NAMED_SECRET,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
  );
  out = out.replace(EMAIL, "[email]");
  if (homeDir && homeDir.length > 1) out = out.split(homeDir).join("~");
  return out;
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
    scope: redactText(entry.scope, homeDir).slice(0, 80),
    message: redactText(entry.message, homeDir).slice(0, 500),
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
      scope: redactText(entry.scope, homeDir),
      message: redactText(entry.message, homeDir),
    })),
  };
}
