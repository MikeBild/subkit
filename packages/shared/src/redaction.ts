export type SecretKind = "pat" | "bearer" | "jwt" | "aws_key" | "key_value";

export interface SecretPattern {
  readonly kind: SecretKind;
  readonly regex: RegExp;
}

const REDACTED = (kind: SecretKind): string => `***REDACTED:${kind}***`;
const DEFAULT_REDACTED = "***redacted***";
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
  "tunnel_api_key",
  "tunnel_token",
  "tunnel_secret",
  "refresh_token",
  "access_token",
  "id_token",
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

export const SENSITIVE_KEY_PATTERN: RegExp =
  /token|secret|password|api[_-]?key|credential|authorization/i;

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { kind: "pat", regex: /\bdop_v1_[A-Za-z0-9]{32,}/g },
  { kind: "pat", regex: /\bghp_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bgho_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bghu_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bghs_[A-Za-z0-9]{30,}/g },
  { kind: "pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "pat", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "pat", regex: /\bsk-[A-Za-z0-9]{20,}/g },
  { kind: "pat", regex: /\bxoxb-[A-Za-z0-9-]{20,}/g },
  { kind: "pat", regex: /\bxoxp-[A-Za-z0-9-]{20,}/g },
  { kind: "aws_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  { kind: "bearer", regex: /Bearer\s+[A-Za-z0-9._-]+/gi },
];

export function scrubString(value: string): string {
  let out = value;
  for (const { kind, regex } of SECRET_PATTERNS) {
    if (out.indexOf("REDACTED:") !== -1 && !regex.test(out)) {
      regex.lastIndex = 0;
      continue;
    }
    regex.lastIndex = 0;
    out = out.replace(regex, REDACTED(kind));
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isAlreadyRedacted(value: string): boolean {
  return /^\*\*\*redacted(?::[a-z_]+)?\*\*\*$/i.test(value);
}

function scrubSecretValue(input: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;
  if (depth >= SCRUB_SECRETS_MAX_DEPTH) return "[depth-exceeded]";

  const obj = input as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(input)) {
    return input.map((item) => scrubSecretValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === "string") {
      out[key] = isAlreadyRedacted(value) ? value : REDACTED("key_value");
    } else {
      out[key] = scrubSecretValue(value, depth + 1, seen);
    }
  }
  return out;
}

export function scrubSecrets(payload: unknown): unknown {
  return scrubSecretValue(payload, 0, new WeakSet<object>());
}

function scrubLogString(value: string): string {
  let out = value;
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
    if (LOG_SENSITIVE_KEYS.has(key.toLowerCase())) {
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
