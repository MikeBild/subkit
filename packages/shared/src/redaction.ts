export type SecretKind = "pat" | "bearer" | "jwt" | "aws_key" | "key_value" | "generic" | "prompt";

export interface SecretPattern {
  readonly kind: SecretKind;
  readonly regex: RegExp;
}

const REDACTED = (kind: SecretKind): string => `***REDACTED:${kind}***`;
export const DEFAULT_REDACTED = "***redacted***";
const SCRUB_SECRETS_MAX_DEPTH = 16;

const LOG_SENSITIVE_KEYS = new Set<string>([
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "set-cookie",
  "master_key",
  "bot_token",
  "client_secret",
  "signing_secret",
  "service_account_json",
  "private_key",
  "slack_signing_secret",
  "slack_bot_token",
  "teams_app_password",
  "teams_client_secret",
  "google_service_account",
  "google_service_account_json",
  "google_credentials_json",
  "refresh_token",
  "access_token",
  "id_token",
  "session_token",
  "secret_key",
  "secret_access_key",
  "aws_secret_access_key",
  "passphrase",
  "webhook_secret",
  "client_assertion",
  "database_url",
  "connection_string",
  "connectionstring",
]);

const LOG_SCRUBBERS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /v0=[a-f0-9]{16,}/gi,
  /wf_(live|test)_[a-zA-Z0-9]+/g,
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/gi,
];

export function isLogSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return LOG_SENSITIVE_KEYS.has(key.toLowerCase()) || LOG_SENSITIVE_KEYS.has(normalized);
}

export const SENSITIVE_KEY_PATTERN: RegExp =
  /token|secret|password|api[_-]?key|credential|authorization/i;
const PROSE_KEY_PATTERN: RegExp = /prompt|messages|instructions/i;
const BODY_KEY_PATTERN: RegExp = /(?:^|_)body$/i;

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    kind: "generic",
    regex:
      /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { kind: "pat", regex: /\bdop_v1_[A-Za-z0-9]{32,}/g },
  { kind: "pat", regex: /\bghp_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bgho_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bghu_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bghs_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "pat", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "pat", regex: /\bATATT[A-Za-z0-9_\-+/=]{20,}/g },
  { kind: "pat", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "pat", regex: /\bsk-[A-Za-z0-9]{20,}/g },
  { kind: "pat", regex: /\bxoxb-[A-Za-z0-9-]{20,}/g },
  { kind: "pat", regex: /\bxoxp-[A-Za-z0-9-]{20,}/g },
  { kind: "pat", regex: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: "aws_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    kind: "bearer",
    regex:
      /Bearer\s+(?=[A-Za-z0-9._-]*(?:[0-9_]|\.[A-Za-z0-9_-]))[A-Za-z0-9._-]{7,}[A-Za-z0-9_-]/gi,
  },
];

const GENERIC_TOKEN_RE: RegExp =
  /\b(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*\d[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{32,}/g;

const CODEC_ALPHABETS: ReadonlyArray<string> = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
];

function isCodecAlphabet(match: string): boolean {
  return CODEC_ALPHABETS.some((a) => a.startsWith(match));
}

const CODE_ASSIGNMENT_RE: RegExp =
  /\b(?:var|const|let)(?:\s|\/\*[\s\S]*?\*\/)+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s|\/\*[\s\S]*?\*\/)*=(?:\s|\/\*[\s\S]*?\*\/)*["'`]$/;
const SECRET_VAR_NAME_RE: RegExp =
  /token|secret|api[_-]?key|password|credential|auth|bearer|jwt|pat\b|\bkey\b|session|cookie|signature|\bsig\b/i;

const CODE_CONTEXT_MAX_LOOKBACK = 256;

function isCodeAssignmentValue(text: string, start: number): boolean {
  const floor = Math.max(0, start - CODE_CONTEXT_MAX_LOOKBACK);
  const newline = text.lastIndexOf("\n", start);
  const windowStart = Math.max(floor, newline);
  const window = text.slice(windowStart, start);
  const m = CODE_ASSIGNMENT_RE.exec(window);
  if (!m) return false;
  const varName = m[1]!;
  return !SECRET_VAR_NAME_RE.test(varName);
}

function isCodeLiteral(text: string, start: number, match: string): boolean {
  return isCodecAlphabet(match) || isCodeAssignmentValue(text, start);
}

function scanGenericTokens(text: string): Array<{ start: number; end: number; match: string }> {
  const out: Array<{ start: number; end: number; match: string }> = [];
  for (const g of text.matchAll(GENERIC_TOKEN_RE)) {
    const start = g.index;
    const end = g.index + g[0].length;
    if (
      !isCodeLiteral(text, start, g[0]) &&
      !isPresentableToken(g[0]) &&
      !isPresentableModelId(text, start)
    ) {
      out.push({ start, end, match: g[0] });
    }
  }
  return out;
}

function redactGenericTokens(value: string): string {
  const spans = scanGenericTokens(value);
  let out = value;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i] as { start: number; end: number };
    out = out.slice(0, s.start) + REDACTED("generic") + out.slice(s.end);
  }
  return out;
}

const PRESIGN_QUERY_RE =
  /\bhttps?:\/\/[^\s"'<>]+\?[^\s"'<>]*(?:X-Amz-(?:Algorithm|Signature|Credential)|X-Goog-(?:Algorithm|Signature|Credential)|[Ss]ignature=)[^\s"'<>]*/g;
const PRESIGN_REDACTED_QUERY = "?<presign-redacted>";

function scrubPresignUrls(value: string): string {
  return value.replace(
    PRESIGN_QUERY_RE,
    (match) => `${match.slice(0, match.indexOf("?"))}${PRESIGN_REDACTED_QUERY}`,
  );
}

const PRESENTABLE_TOKEN_RE = /^(?:[A-Za-z]+=)?sk(?:og|sg|ag)_[A-Za-z0-9_-]{20,}$/;

function isPresentableToken(match: string): boolean {
  return PRESENTABLE_TOKEN_RE.test(match);
}

const ORG_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const ORG_MODEL_PREFIX_RE = new RegExp(`[^\\w./-]${ORG_SEGMENT}/$`);
const ORG_MODEL_PREFIX_AT_START_RE = new RegExp(`^${ORG_SEGMENT}/$`);
const ORG_MODEL_MAX_LOOKBACK = 128;

function isPresentableModelId(text: string, start: number): boolean {
  const floor = Math.max(0, start - ORG_MODEL_MAX_LOOKBACK);
  const window = text.slice(floor, start);
  if (ORG_MODEL_PREFIX_RE.test(window)) return true;
  return floor === 0 && ORG_MODEL_PREFIX_AT_START_RE.test(window);
}

export function scrubString(value: string): string {
  let out = scrubPresignUrls(value);
  for (const { kind, regex } of SECRET_PATTERNS) {
    out = out.replace(regex, (match) => (isPresentableToken(match) ? match : REDACTED(kind)));
  }
  out = redactGenericTokens(out);
  return out;
}

interface SecretShapeRedaction {
  text: string;
  count: number;
}

export function redactSecretShapes(value: string): SecretShapeRedaction {
  let count = 0;
  let out = value.replace(PRESIGN_QUERY_RE, (match) => {
    count++;
    return `${match.slice(0, match.indexOf("?"))}${PRESIGN_REDACTED_QUERY}`;
  });
  for (const { kind, regex } of SECRET_PATTERNS) {
    out = out.replace(regex, (match) => {
      if (isPresentableToken(match)) return match;
      count++;
      return REDACTED(kind);
    });
  }
  return { text: out, count };
}

export interface SecretSpan {
  start: number;
  end: number;
  kind: SecretKind;
  match: string;
}

const REDACTED_MARKER_RE = /\*\*\*REDACTED:[a-z_]+\*\*\*/g;

function overlapsAny(
  start: number,
  end: number,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start < r.end && r.start < end);
}

export function findSecretSpans(text: string): SecretSpan[] {
  const markers = Array.from(text.matchAll(REDACTED_MARKER_RE), (marker) => ({
    start: marker.index,
    end: marker.index + marker[0].length,
  }));

  const spans: SecretSpan[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    for (const m of text.matchAll(regex)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (
        !isPresentableToken(m[0]) &&
        !overlapsAny(start, end, markers) &&
        !overlapsAny(start, end, spans)
      ) {
        spans.push({ start, end, kind, match: m[0] });
      }
    }
    regex.lastIndex = 0;
  }

  for (const s of scanGenericTokens(text)) {
    if (!overlapsAny(s.start, s.end, markers) && !overlapsAny(s.start, s.end, spans)) {
      spans.push({ start: s.start, end: s.end, kind: "generic", match: s.match });
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isProseKey(key: string): boolean {
  return PROSE_KEY_PATTERN.test(key);
}

function isBodyKey(key: string): boolean {
  return BODY_KEY_PATTERN.test(key);
}

export function isAlreadyRedacted(value: string): boolean {
  return /^\*\*\*redacted(?::[a-z_]+)?\*\*\*$/i.test(value);
}

function isPlainCarrier(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export interface ScrubOptions {
  readonly promptKeys?: boolean;
}

function scrubSecretValue(
  input: unknown,
  depth: number,
  seen: WeakSet<object>,
  promptKeys: boolean,
): unknown {
  if (input === null) return input;
  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;
  if (depth >= SCRUB_SECRETS_MAX_DEPTH) return "[depth-exceeded]";

  const obj = input as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(input)) {
    return input.map((item) => scrubSecretValue(item, depth + 1, seen, promptKeys));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === "string") {
      out[key] = isAlreadyRedacted(value) ? value : REDACTED("key_value");
    } else if (
      promptKeys &&
      ((isProseKey(key) && (typeof value === "string" || isPlainCarrier(value))) ||
        (isBodyKey(key) && typeof value === "string"))
    ) {
      out[key] = typeof value === "string" && isAlreadyRedacted(value) ? value : REDACTED("prompt");
    } else {
      out[key] = scrubSecretValue(value, depth + 1, seen, promptKeys);
    }
  }
  return out;
}

export function scrubSecrets(payload: unknown, options?: ScrubOptions): unknown {
  return scrubSecretValue(payload, 0, new WeakSet<object>(), options?.promptKeys ?? true);
}

function scrubStringsDeepValue(input: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (input === null) return input;
  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;
  if (depth >= SCRUB_SECRETS_MAX_DEPTH) return "[depth-exceeded]";

  const obj = input as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(input)) {
    return input.map((item) => scrubStringsDeepValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = scrubStringsDeepValue(value, depth + 1, seen);
  }
  return out;
}

export function scrubStringsDeep(value: unknown): unknown {
  return scrubStringsDeepValue(value, 0, new WeakSet<object>());
}

function scrubLogString(value: string): string {
  let out = scrubPresignUrls(value);
  for (const re of LOG_SCRUBBERS) {
    out = out.replace(re, DEFAULT_REDACTED);
  }
  return out;
}

function redactInner(input: unknown, depth: number, maxDepth: number): unknown {
  if (input == null) return input;
  if (depth >= maxDepth) return "[depth-exceeded]";

  if (typeof input === "string") return scrubLogString(input);
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactInner(item, depth + 1, maxDepth));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isLogSensitiveKey(key)) {
      out[key] = DEFAULT_REDACTED;
    } else {
      out[key] = redactInner(value, depth + 1, maxDepth);
    }
  }
  return out;
}

export function redactWithMaxDepth(input: unknown, maxDepth: number, depth = 0): unknown {
  return scrubSecrets(redactInner(input, depth, maxDepth));
}

const PATH_START = "(?<![\\w.~/$-])";

const KEY_MATERIAL_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`${PATH_START}[\\w.~-]*\\/[\\w./~-]*[\\w-]\\.key(?![\\w-])`, "i"),
  new RegExp(`${PATH_START}[\\w./~-]*[\\w-]\\.(?:pem|p12|pfx)(?![\\w-])`, "i"),
  new RegExp(`${PATH_START}(?:[\\w.~-]*\\/)*\\.env(?:\\.[\\w-]+)*(?![\\w-])`, "i"),
  /(?:~|\$HOME|(?<![\w.-])[\w.-]*)\/\.(?:ssh|gnupg)(?![\w-])/i,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)(?![\w-])/i,
  /\/etc\/(?:[\w.-]+\/)+[\w.-]*(?:key|secret|credential)/i,
  /(?:\/run\/secrets|\/\.aws\/credentials|\/\.docker\/config\.json|\/\.netrc|\/\.pgpass)(?![\w-])/i,
];

export function referencesKeyMaterialPath(text: string): boolean {
  return KEY_MATERIAL_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

function encodedForms(secret: string): string[] {
  const form = new URLSearchParams({ v: secret }).toString().slice(2);
  return [secret, encodeURIComponent(secret), form, JSON.stringify(secret).slice(1, -1)];
}

export function knownValueForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of encodedForms(secret)) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function redactKnownText(text: string, forms: readonly string[]): string {
  let out = text;
  for (const form of forms) out = out.split(form).join(DEFAULT_REDACTED);
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactKnownValues<T>(value: T, secrets: readonly string[]): T {
  const forms = knownValueForms(secrets);
  if (forms.length === 0) return value;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return redactKnownText(current, forms);
    if (Array.isArray(current)) return current.map(walk);
    if (current instanceof Error) {
      current.message = redactKnownText(current.message, forms);
      return current;
    }
    if (isPlainRecord(current)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) out[key] = walk(item);
      return out;
    }
    return current;
  };
  return walk(value) as T;
}

const DIAGNOSTIC_URL = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>)\]}]+/gi;
const DIAGNOSTIC_AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const DIAGNOSTIC_UNIX_PATH =
  /(?<![\w.:/~-])(?:~|\/(?:Users|home|root|var|private|tmp|etc|opt|usr|Volumes|mnt|srv|Library|Applications|System))\/[^\s"'`<>|;,()]*/g;
const DIAGNOSTIC_WINDOWS_PATH = /(?<!\w)(?:[A-Za-z]:\\|\\\\)[^\s"'`<>|;,()]*/g;
const DIAGNOSTIC_JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const DIAGNOSTIC_API_KEY = /\bsk[_-][A-Za-z0-9_-]{8,}/g;
const DIAGNOSTIC_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIAGNOSTIC_NAMED_SECRET =
  /\b(code_verifier|code_challenge|code|state|access_token|refresh_token|id_token|client_secret|token|password|passwd|secret|api[_-]?key|set-cookie|cookie|authorization|session(?:_id)?)\b(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi;
export const REDACTED_EMAIL = "***email***";
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export function redactUrl(raw: string, mask = DEFAULT_REDACTED): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return mask;
  }
  if (WEB_PROTOCOLS.has(url.protocol)) {
    const detail = url.pathname !== "/" || url.search || url.hash;
    return `${url.protocol}//${url.host}${detail ? `/${mask}` : ""}`;
  }
  return `${url.protocol}//${mask}`;
}

export function redactDiagnosticText(
  text: string,
  options: { mask?: string | undefined; homeDir?: string | undefined } = {},
): string {
  const { mask, homeDir } = options;
  const secret = mask ?? DEFAULT_REDACTED;
  const home = homeDir && homeDir.length > 1 ? text.split(homeDir).join("~") : text;
  let out = home.replace(DIAGNOSTIC_URL, (match) => redactUrl(match, secret));
  out = out.replace(DIAGNOSTIC_AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${secret}`);
  out = out.replace(DIAGNOSTIC_JWT, secret);
  out = out.replace(DIAGNOSTIC_API_KEY, secret);
  out = out.replace(
    DIAGNOSTIC_NAMED_SECRET,
    (_match, name: string, separator: string) => `${name}${separator}${secret}`,
  );
  out = out.replace(DIAGNOSTIC_UNIX_PATH, secret);
  out = out.replace(DIAGNOSTIC_WINDOWS_PATH, secret);
  return out.replace(DIAGNOSTIC_EMAIL, mask ?? REDACTED_EMAIL);
}

export function redactedRequestTarget(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {}
  return `${url.origin}${path}`;
}
