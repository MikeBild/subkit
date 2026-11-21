import { redactSecretShapes } from "../../logging/scrub-secrets.ts";

export const FEEDBACK_REMOVED = "[removed]";
export const FEEDBACK_EMAIL = "[email]";
export const FEEDBACK_PATH = "[path]";

const HEADER_SECRET =
  /\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token|x-subkit-csrf)\b(["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const NAMED_SECRET =
  /\b(code_verifier|access_token|refresh_token|id_token|client_secret|session_id|token|password|passwd|secret|api[_-]?key)\b(["']?\s*[:=]\s*["']?)(?!\[removed\])[^\s"',;&}]+/gi;
const URL = /\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s"'<>)\]}]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PATH_BODY = "[^\\s\"'`<>|;,()]*";
const UNIX_PATH = new RegExp(
  `(?<![\\w.:/~-])(?:~|/(?:Users|home|root|var|private|tmp|etc|opt|usr|Volumes|mnt|srv|Library|Applications|System|proc|run|snap|nix))/${PATH_BODY}`,
  "g",
);
const WINDOWS_PATH = new RegExp(`(?<![\\w])(?:[A-Za-z]:\\\\|\\\\\\\\)${PATH_BODY}`, "g");
const WEB_SCHEMES = new Set(["http", "https", "ws", "wss"]);

export interface FeedbackRedaction<T> {
  readonly value: T;
  readonly count: number;
}

export interface FeedbackRecentError {
  readonly code: string;
  readonly at: string;
}

export interface FeedbackDiagnostics {
  readonly app_version?: string | undefined;
  readonly platform?: string | undefined;
  readonly client_kind?: "browser" | "desktop" | "pwa" | undefined;
  readonly server_version?: string | undefined;
  readonly connection?: string | undefined;
  readonly route?: string | undefined;
  readonly recent_errors?: readonly FeedbackRecentError[] | undefined;
}

function cleanUrl(match: string, scheme: string): { text: string; changed: boolean } {
  const lower = scheme.toLowerCase();
  if (lower === "file") return { text: FEEDBACK_PATH, changed: true };
  if (!WEB_SCHEMES.has(lower)) return { text: `${lower}://${FEEDBACK_REMOVED}`, changed: true };
  const cut = match.search(/[?#]/);
  const base = cut < 0 ? match : match.slice(0, cut);
  const at = base.indexOf("@");
  const authority = base.indexOf("/", lower.length + 3);
  const hasUserinfo = at >= 0 && (authority < 0 || at < authority);
  const text = hasUserinfo ? `${lower}://${base.slice(at + 1)}` : base;
  return { text, changed: text !== match };
}

export function redactFeedbackText(
  input: string,
  options: { emails?: boolean } = {},
): FeedbackRedaction<string> {
  let count = 0;
  const mark = (replacement: string): string => {
    count++;
    return replacement;
  };
  let out = input.replace(HEADER_SECRET, (_match, name: string, separator: string) =>
    mark(`${name}${separator}${FEEDBACK_REMOVED}`),
  );
  out = out.replace(AUTH_SCHEME, (_match, scheme: string) => mark(`${scheme} ${FEEDBACK_REMOVED}`));
  out = out.replace(URL, (match, scheme: string) => {
    const cleaned = cleanUrl(match, scheme);
    if (cleaned.changed) count++;
    return cleaned.text;
  });
  out = out.replace(NAMED_SECRET, (_match, name: string, separator: string) =>
    mark(`${name}${separator}${FEEDBACK_REMOVED}`),
  );
  const shapes = redactSecretShapes(out);
  out = shapes.text;
  count += shapes.count;
  out = out.replace(UNIX_PATH, () => mark(FEEDBACK_PATH));
  out = out.replace(WINDOWS_PATH, () => mark(FEEDBACK_PATH));
  if (options.emails) out = out.replace(EMAIL, () => mark(FEEDBACK_EMAIL));
  return { value: out, count };
}

export function redactFeedbackRoute(route: string): FeedbackRedaction<string> {
  const cut = route.search(/[?#]/);
  const path = cut < 0 ? route : route.slice(0, cut);
  const cleaned = redactFeedbackText(path, { emails: true });
  return { value: cleaned.value, count: cleaned.count + (cut < 0 ? 0 : 1) };
}

export function redactFeedbackDiagnostics(
  diagnostics: FeedbackDiagnostics,
): FeedbackRedaction<FeedbackDiagnostics> {
  let count = 0;
  const text = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const cleaned = redactFeedbackText(value, { emails: true });
    count += cleaned.count;
    return cleaned.value;
  };
  const route =
    diagnostics.route === undefined ? undefined : redactFeedbackRoute(diagnostics.route);
  count += route?.count ?? 0;
  const value: FeedbackDiagnostics = {
    app_version: text(diagnostics.app_version),
    platform: text(diagnostics.platform),
    client_kind: diagnostics.client_kind,
    server_version: text(diagnostics.server_version),
    connection: text(diagnostics.connection),
    route: route?.value,
    recent_errors: diagnostics.recent_errors?.map((entry) => ({
      code: text(entry.code) ?? "",
      at: entry.at,
    })),
  };
  return { value, count };
}

export function redactFeedbackFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const printable = [...base].filter((char) => char.charCodeAt(0) >= 32).join("");
  const cleaned = redactFeedbackText(printable, { emails: true }).value.trim();
  return cleaned.replace(/^\.+/, "").slice(0, 120) || "attachment";
}
