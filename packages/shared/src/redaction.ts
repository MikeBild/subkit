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
  // The operand must be ≥8 token chars AND carry at least one digit /
  // dot / underscore / hyphen — true Authorization operands (JWTs,
  // PATs, opaque tokens) always do, while prose words ("bearer auth",
  // "Bearer tokens", "bearer authentication") never do. Needed since
  // this pattern also runs over assistant text via the output-guard
  // secret pre-pass (caught live: "proceed with ***REDACTED:bearer***
  // auth" in a connector-authoring reply).
  {
    kind: "bearer",
    regex: /Bearer\s+(?=[A-Za-z0-9._-]*[0-9._-])[A-Za-z0-9._-]{8,}/gi,
  },
  // NOTE: the `generic` high-entropy matcher is NOT in this flat-replace
  // loop. It lives in `GENERIC_TOKEN_RE` and runs through a separate,
  // code-context-suppressed pass (`redactGenericTokens` / the parallel
  // scan in `findSecretSpans`) so it redacts a bare high-entropy run on
  // shape but leaves codec alphabets and non-secret `var/const/let = "..."`
  // literals alone. See `GENERIC_TOKEN_RE` below.
];

// Generic high-entropy token: a contiguous 32+ char run over the token
// charset that mixes lower case, upper case, and at least two digits.
// Deliberately excluded by construction: hex SHAs / lowercase UUIDs (no
// uppercase), SCREAMING_SNAKE constants (no lowercase), camelCase ids
// (no digits / too short), Mustache `{{token}}` (`{`/`}` not in charset),
// and individual file-path segments (`/` not in charset).
//
// A run of this shape with no surrounding context is treated as a secret
// and redacted — a real opaque credential pasted into chat (`here you
// go: <token>`, a lone-paste) carries no vendor prefix and no keyword,
// so shape is the only signal we have. The redactor therefore fires on
// shape by default.
//
// The shape alone is, however, too broad: a base64 / base32 / hex
// *alphabet* literal, a content hash, or a reverse-lookup table all
// satisfy it. Redacting those corrupted authored workflow / code
// definitions into a malformed body (the validated v7.5 outage). The
// outage literal was always inside source: the bare standard alphabet
// assigned as the full value of a quoted string (`var B="<alphabet>"`).
// So this matcher is CODE-CONTEXT-SUPPRESSED — a candidate run is
// redacted UNLESS it is a known codec alphabet (an ordered base64 /
// base32 / hex sequence) or it sits as the entire value of a
// `var/const/let <non-secret-name> = "..."` assignment. A bare token
// with no such code framing still redacts. Vendor-prefixed kinds above
// are unaffected and still own their span/kind when both shapes match
// (run them first, then this).
const GENERIC_TOKEN_RE: RegExp =
  /\b(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*\d[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{32,}/g;

// Known codec alphabets, ordered. These are the literals a hand-rolled
// base64 / base32 / hex encoder embeds as a lookup table; redacting one
// corrupts the encoder (the validated outage). Compared against the
// matched run directly so only an exact ordered alphabet is suppressed —
// a credential that merely reuses the same charset (random order) does
// not match.
const CODEC_ALPHABETS: ReadonlyArray<string> = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", // base32 RFC 4648
  "0123456789abcdefghijklmnopqrstuvwxyz", // base36
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", // base36 upper
];

function isCodecAlphabet(match: string): boolean {
  // The trailing `/` of the standard base64 alphabet is not in the token
  // charset, so the matched run is the alphabet truncated at the first
  // out-of-charset character. Treat the run as a codec alphabet when it
  // is a contiguous prefix of a known ordered alphabet AND covers the
  // bulk of it (≥ 32 chars already guaranteed by the matcher) — this
  // recognizes `…789+` (standard) and the url-safe `…789-_` form alike
  // while a random credential reusing the charset will not be an ordered
  // prefix.
  return CODEC_ALPHABETS.some((a) => a.startsWith(match));
}

// A high-entropy run is part of source code — NOT a pasted secret — when
// it is the entire value of a `var/const/let <name> = "..."` assignment
// whose variable name is not itself a secret keyword. The outage shape
// was `var B="<alphabet>"`: the quote characters break the token charset
// (quotes are not in `[A-Za-z0-9+=_-]`), so the matched run is the
// alphabet content only and the lookback window ends just before the
// opening quote. We re-walk that window here. A secret-named variable
// (`const apiKey = "..."`) is deliberately NOT suppressed — that is a
// credential literal, not codec source.
// `var/const/let <name> = "` with an OPTIONAL inline block comment after
// the keyword and around the `=` — `var /* note */ B = "…"` is the same
// code-assignment shape and must be recognized so a long comment cannot
// smuggle the alphabet literal past the suppression (the outage shape).
// `(?:\s|\/\*[\s\S]*?\*\/)+` matches a run of whitespace and/or block
// comments (`[\s\S]` is the lint-clean match-any so a comment can span
// newlines).
const CODE_ASSIGNMENT_RE: RegExp =
  /\b(?:var|const|let)(?:\s|\/\*[\s\S]*?\*\/)+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s|\/\*[\s\S]*?\*\/)*=(?:\s|\/\*[\s\S]*?\*\/)*["'`]$/;
// Secret-named variables whose high-entropy literal value is a real
// credential in source, not codec data — keep redacting those. `bearer`,
// `jwt`, `pat`, a standalone `key`, plus `session`/`cookie`/`signature`/
// `sig`, are common credential variable names that the original allowlist
// (`token|secret|api_key|password|credential|auth`) missed, so a
// `const bearer = "<hi-entropy>"` slipped through the code-context
// suppression and survived unredacted.
//
// DELIBERATELY EXCLUDED: `data|raw|payload|body|value|blob|hash` and the
// like. Those are ordinary code-literal variable names — `const raw =
// "<base64>"` is exactly the outage class this whole pass exists to protect
// (a hand-rolled encoder's alphabet must survive verbatim). Adding them
// would re-introduce the corruption regression, so the allowlist only ever
// grows with names that do NOT collide with legitimate code literals.
const SECRET_VAR_NAME_RE: RegExp =
  /token|secret|api[_-]?key|password|credential|auth|bearer|jwt|pat\b|\bkey\b|session|cookie|signature|\bsig\b/i;

// Hard cap on the assignment lookback. A `const <name> = "` prefix is
// short, but a long inline comment between the keyword and the literal
// (`var /* …very long… */ B = "<alphabet>"`) can push the assignment
// further back than a small fixed window — exactly the shape that would
// re-trigger the outage if the window were too tight. We instead scan
// back to the nearest newline (an assignment lives on one logical source
// line), capped here so a pathological comment-free line can't blow up
// the regex scan.
const CODE_CONTEXT_MAX_LOOKBACK = 256;

function isCodeAssignmentValue(text: string, start: number): boolean {
  // Walk back to the start of the current source line (nearest newline),
  // bounded by CODE_CONTEXT_MAX_LOOKBACK so a long inline comment between
  // the `var`/`const`/`let` keyword and the opening quote still lands
  // inside the window instead of being truncated past it.
  const floor = Math.max(0, start - CODE_CONTEXT_MAX_LOOKBACK);
  const newline = text.lastIndexOf("\n", start - 1);
  const windowStart = Math.max(floor, newline + 1);
  const window = text.slice(windowStart, start);
  const m = CODE_ASSIGNMENT_RE.exec(window);
  if (!m) return false;
  const varName = m[1] ?? "";
  // A secret-named variable holding a high-entropy literal is a real
  // credential in source, not codec data — keep redacting it.
  return !SECRET_VAR_NAME_RE.test(varName);
}

// True when the run is code, not a secret: an ordered codec alphabet, or
// the full value of a non-secret `var/const/let = "..."` assignment.
function isCodeLiteral(text: string, start: number, match: string): boolean {
  return isCodecAlphabet(match) || isCodeAssignmentValue(text, start);
}

// ── REDACTION CONTRACT (authoritative) ─────────────────────────────────
// The generic high-entropy matcher is CODE-CONTEXT-SUPPRESSED. It redacts
// a bare high-entropy run on shape by default — including the lone-paste /
// `here you go: <token>` shape with no keyword and no vendor prefix — but
// it leaves a known codec alphabet or a non-secret `var/const/let = "..."`
// literal alone, so a pasted workflow / code definition survives VERBATIM
// (into replay, transcripts, and assistant output) while a genuine pasted
// secret still scrubs. Vendor-prefixed credential capture is unaffected.
// This is the contract `redactGenericTokens` (string scrub) and the
// parallel pass in `findSecretSpans` (span detection for assistant text)
// both implement; call sites that scrub user/assistant text MUST NOT
// re-describe it — point here instead. Reopening it (e.g. a too-tight code
// lookback window) is the v7.5 Gmail-send outage.
//
// RESIDUAL EVASION CLASS (known and accepted). The code-context
// suppression keys on the variable NAME of a `var/const/let <name> = "..."`
// assignment: a secret-named variable (`apiKey`, `bearer`, `session`, …)
// still redacts, but a neutrally-named one (`const data = "<token>"`,
// `const raw = "<token>"`) survives. That means a high-entropy secret
// DELIBERATELY pasted into a neutrally-named string literal will pass
// through unredacted. This is accepted on purpose: the suppression is
// best-effort against HONEST mistakes (a user pasting a real codec
// alphabet / SHA / lookup table), NOT a defense against adversarial paste —
// trying to redact `const data = "<base64-shaped>"` is precisely what
// corrupted authored encoders in the outage. The backstop that does NOT
// depend on the variable name: a VENDOR-PREFIXED secret (`ghp_`, `sk-ant`,
// `AKIA…`, a JWT `eyJ…`, etc.) is matched by the `SECRET_PATTERNS` loop
// FIRST and redacts INSIDE any assignment regardless of the variable name,
// because those patterns fire on the value's shape, not its code framing.
/**
 * Single source of truth for the code-context-suppressed generic token scan.
 *
 * Both the user-text scrubber (`scrubString` → `redactGenericTokens`) and the
 * assistant-text span pass (`findSecretSpans`) consume this so they can NEVER
 * diverge — divergence is exactly what reopened the redaction-corruption class.
 * Returns every high-entropy run that should redact: not a code literal, not a
 * presentable token, and not already covered by the caller (vendor spans /
 * prior `***REDACTED***` markers). `GENERIC_TOKEN_RE.exec` advances past each
 * match, so returned spans never overlap each other.
 */
function scanGenericTokens(
  text: string,
  isCovered: (start: number, end: number) => boolean,
): Array<{ start: number; end: number; match: string }> {
  const out: Array<{ start: number; end: number; match: string }> = [];
  GENERIC_TOKEN_RE.lastIndex = 0;
  let g: RegExpExecArray | null = GENERIC_TOKEN_RE.exec(text);
  while (g !== null) {
    const start = g.index;
    const end = g.index + g[0].length;
    if (
      !isCodeLiteral(text, start, g[0]) &&
      !isPresentableToken(g[0]) &&
      !isPresentableModelId(text, start) &&
      !isCovered(start, end)
    ) {
      out.push({ start, end, match: g[0] });
    }
    g = GENERIC_TOKEN_RE.exec(text);
  }
  GENERIC_TOKEN_RE.lastIndex = 0;
  return out;
}

function redactGenericTokens(value: string): string {
  // scrubString runs this AFTER the vendor loop has already replaced its
  // secrets with markers, so there are no caller-covered spans to honour here.
  const spans = scanGenericTokens(value, () => false);
  if (spans.length === 0) return value;
  let out = value;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i] as { start: number; end: number };
    out = out.slice(0, s.start) + REDACTED("generic") + out.slice(s.end);
  }
  return out;
}

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

/**
 * Deliberately presentable token forms the scrubber must NOT redact.
 *
 * `skog_…` — single-use OAuth start grants (connector re-auth). Their
 * entire purpose is to be shown to a human who opens the URL in a
 * browser; redacting one bricks the re-auth flow on every surface
 * (caught live: `?grant=***REDACTED:generic***` in the first 6.18.x
 * deploy made the sign-in link unusable). The exposure is bounded by
 * design — 10-min TTL, atomic single-use claim, sha256-at-rest, and an
 * issued/consumed audit pair — which is exactly why the prefix exists:
 * it marks the token as a user-facing capability, not a credential.
 */
// The generic charset includes `=`, so inside a URL the matched run is
// `grant=skog_…` — allow exactly one optional `<param>=` prefix ahead
// of the grant, nothing else.
const PRESENTABLE_TOKEN_RE = /^(?:[A-Za-z]+=)?skog_[A-Za-z0-9_-]{20,}$/;

function isPresentableToken(match: string): boolean {
  return PRESENTABLE_TOKEN_RE.test(match);
}

/**
 * Public `org/model` identifiers (e.g. the embedding model id
 * `Xenova/paraphrase-multilingual-MiniLM-L12-v2`) are presentable NAMES,
 * not credentials. The model-name half is a long mixed-case run with
 * digits, so the generic high-entropy matcher fires on it and clobbers the
 * field (caught live: `"model":"Xenova/***REDACTED:generic***"`). The `/`
 * is outside the token charset, so the matched run is only the model half;
 * we recover the org context from a bounded lookback and treat the run as
 * presentable when it sits directly after a single `<org>/` slug.
 *
 * GENERALIZED BY SHAPE — no vendor name is encoded. The org segment must be
 * a STANDALONE identifier: its left boundary is the absolute start of the
 * text or a non-path delimiter (`"`, space, `=`, `:`, …), never `/` or `.`.
 * That bound keeps a secret embedded in a multi-segment URL path
 * (`https://host/dl/<token>`) or after a domain (`host.tld/<token>`) OUT of
 * the allowlist — only a clean, standalone `org/model` value is exempted.
 */
const ORG_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
// A `<org>/` immediately before the run, with a non-path boundary in front
// of the org so a longer path/URL segment cannot masquerade as the org.
const ORG_MODEL_PREFIX_RE = new RegExp(`[^\\w./-]${ORG_SEGMENT}/$`);
// Same, but the org sits at the very start of the text (no boundary char).
const ORG_MODEL_PREFIX_AT_START_RE = new RegExp(`^${ORG_SEGMENT}/$`);
const ORG_MODEL_MAX_LOOKBACK = 128;

function isPresentableModelId(text: string, start: number): boolean {
  // The run must sit directly after the `/` of an `<org>/<model>` id.
  if (start === 0 || text[start - 1] !== "/") return false;
  const floor = Math.max(0, start - ORG_MODEL_MAX_LOOKBACK);
  const window = text.slice(floor, start); // ends with "<org>/"
  if (ORG_MODEL_PREFIX_RE.test(window)) return true;
  // Only honour the start-anchored form when `floor` is the true text start —
  // a truncated window must require an explicit preceding boundary so a long
  // org-shaped run can't smuggle a path-embedded secret past the bound.
  return floor === 0 && ORG_MODEL_PREFIX_AT_START_RE.test(window);
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
    out = out.replace(regex, (match) => (isPresentableToken(match) ? match : REDACTED(kind)));
  }
  // Code-context-suppressed generic pass runs AFTER the vendor-prefixed
  // loop so a vendor pattern already owns its span (and the `?` skip +
  // the marker it left keeps this pass from re-touching it). A bare
  // high-entropy token redacts on shape; a codec alphabet or a
  // non-secret `var/const/let = "..."` literal survives.
  out = redactGenericTokens(out);
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
      if (
        !isPresentableToken(m[0]) &&
        !overlapsAny(start, end, markers) &&
        !overlapsAny(start, end, spans)
      ) {
        spans.push({ start, end, kind, match: m[0] });
      }
      m = regex.exec(text);
    }
    regex.lastIndex = 0;
  }

  // Code-context-suppressed generic pass — shares `scanGenericTokens` with
  // `scrubString`'s `redactGenericTokens` so user-text and assistant-text
  // redact the same runs (the consolidation that prevents divergence). Vendor
  // spans were pushed first above, so a candidate overlapping one (or a prior
  // marker) is skipped.
  for (const s of scanGenericTokens(
    text,
    (start, end) => overlapsAny(start, end, markers) || overlapsAny(start, end, spans),
  )) {
    spans.push({ start: s.start, end: s.end, kind: "generic", match: s.match });
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
