export type SecretKind = "pat" | "bearer" | "jwt" | "aws_key" | "key_value" | "generic";

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
  { kind: "bearer", regex: /Bearer\s+[A-Za-z0-9._-]+/gi },
  // Generic high-entropy token: a contiguous 32+ char run over the
  // token charset that mixes lower case, upper case, and at least two
  // digits. The lookaheads are confined to the token charset itself,
  // so they can never cross whitespace — the assertions hold *within*
  // the contiguous run. Deliberately excluded by construction:
  //   - hex SHAs / lowercase UUIDs (no uppercase),
  //   - uppercase UUIDs / ULIDs / SCREAMING_SNAKE constants (no lowercase),
  //   - camelCase identifiers (no digits / too short),
  //   - Mustache placeholders like `{{token}}` (`{`/`}` not in charset).
  // MUST stay last: a vendor-prefixed pattern above should own the span
  // (and its kind) when both match.
  {
    kind: "generic",
    regex:
      /\b(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*\d[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/g,
  },
];

/**
 * Presigned-URL query-string detector. Matches any URL whose query
 * string carries an upload-signature parameter and replaces the entire
 * query with a fixed sentinel so the signature, expiry, and any other
 * parameters never land in audit / log storage.
 *
 * Defense-in-depth: no current emitter persists presign URLs in audit
 * metadata, but the redactor keeps incidental leakage out of audit and
 * structured-log storage. Audit rows are append-only — a leaked HMAC
 * would survive forever and the URL itself confers write access to the
 * underlying object until the signature expires (typically 1h, but
 * cloud providers allow up to 7 days).
 *
 * Covered URL flavours:
 *   - S3 sigv4: `?X-Amz-Algorithm=...&X-Amz-Signature=...`
 *   - GCS V4 / V2 signed URLs: `?X-Goog-Algorithm=...&X-Goog-Signature=...`
 *   - Generic HMAC presign: `?signature=...` or `?Signature=...`
 *
 * The detection is intentionally narrow on the query parameter name —
 * a normal URL like `https://example.com/api?page=1` is left alone.
 */
const PRESIGN_QUERY_RE =
  /\bhttps?:\/\/[^\s"'<>]+\?[^\s"'<>]*(?:X-Amz-(?:Algorithm|Signature|Credential)|X-Goog-(?:Algorithm|Signature|Credential)|[Ss]ignature=)[^\s"'<>]*/g;
const PRESIGN_REDACTED_QUERY = "?<presign-redacted>";

function scrubPresignUrls(value: string): string {
  if (value.indexOf("?") === -1) return value;
  return value.replace(PRESIGN_QUERY_RE, (match) => {
    const q = match.indexOf("?");
    if (q === -1) return match;
    return `${match.slice(0, q)}${PRESIGN_REDACTED_QUERY}`;
  });
}

export function scrubString(value: string): string {
  // Strip presign URL query strings BEFORE the per-pattern token loop
  // so the in-query secrets (X-Amz-Signature, X-Goog-Signature, JWT-
  // shaped credentials inside X-Amz-Credential) are never touched —
  // we replace the whole query, which is both cheaper and free of the
  // false-positive risk of trying to match individual signature bytes.
  let out = scrubPresignUrls(value);
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

export interface SecretSpan {
  start: number;
  end: number;
  kind: SecretKind;
  match: string;
}

/** Kinded redaction markers produced by `scrubString` — spans that
 *  overlap one are already handled and must not be re-reported. */
const REDACTED_MARKER_RE = /\*\*\*REDACTED:[a-z_]+\*\*\*/g;

function overlapsAny(
  start: number,
  end: number,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start < r.end && r.start < end);
}

/**
 * Locate every secret-shaped span in `text` WITHOUT rewriting it.
 * Pattern order is authoritative: when two patterns match overlapping
 * ranges, the earlier pattern in `SECRET_PATTERNS` owns the span (same
 * winner `scrubString`'s sequential replace would produce). Spans that
 * overlap an existing `***REDACTED:<kind>***` marker are skipped — the
 * text already went through a scrub pass. Result is sorted by `start`.
 */
export function findSecretSpans(text: string): SecretSpan[] {
  const markers: Array<{ start: number; end: number }> = [];
  REDACTED_MARKER_RE.lastIndex = 0;
  let marker: RegExpExecArray | null = REDACTED_MARKER_RE.exec(text);
  while (marker !== null) {
    markers.push({ start: marker.index, end: marker.index + marker[0].length });
    marker = REDACTED_MARKER_RE.exec(text);
  }
  REDACTED_MARKER_RE.lastIndex = 0;

  const spans: SecretSpan[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null = regex.exec(text);
    while (m !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (!overlapsAny(start, end, markers) && !overlapsAny(start, end, spans)) {
        spans.push({ start, end, kind, match: m[0] });
      }
      m = regex.exec(text);
    }
    regex.lastIndex = 0;
  }
  return spans.sort((a, b) => a.start - b.start);
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

function scrubStringsDeepValue(input: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (input === null || input === undefined) return input;
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

/**
 * Pattern-only deep scrub: walks the value like `scrubSecrets` but
 * WITHOUT the sensitive-key branch — string leaves go through
 * `scrubString` only. A field legitimately *named* `token` or
 * `credential` (e.g. a form field definition or a Mustache reference
 * like `Bearer {{token}}`) passes untouched; only values that LOOK
 * like secrets are rewritten. Use for user-facing payloads where key
 * names are structure, not secrets.
 */
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
