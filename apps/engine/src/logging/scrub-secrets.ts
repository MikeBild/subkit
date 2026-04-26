// Secret-shape scrubber. Replaces well-known token shapes with
// `***REDACTED:<kind>***` everywhere a payload can be serialized to a
// log line, audit row, or `~/.sk/debug.log` entry.
//
// This module is the gate between sensitive data and any disk / wire
// surface. Callers must apply it at the entry point of each sink so
// that downstream serialization can never accidentally bypass it.
//
// Constraints:
//   - Pure, deterministic, no I/O, no throws.
//   - O(n) on payload size. All regex anchors are linear; no
//     catastrophic backtracking.
//   - Walk depth-limit 16 with a `WeakSet` cycle guard.
//   - Sensitive keys (token / secret / password / api_key /
//     credential / authorization) redact their string-typed values
//     entirely, regardless of substring shape — this is the broad
//     net. The shape patterns are the targeted net.

export type SecretKind = "pat" | "bearer" | "jwt" | "aws_key" | "key_value";

export interface SecretPattern {
  readonly kind: SecretKind;
  readonly regex: RegExp;
}

const REDACTED = (kind: SecretKind): string => `***REDACTED:${kind}***`;

const MAX_DEPTH = 16;

/**
 * Match any sensitive key name. Used to redact the entire string
 * value at the matching key, even when the value's shape does not
 * match a known token pattern (defence in depth).
 *
 * Matches: token, secret, password, api_key / api-key / apikey,
 * credential / credentials, authorization. Case-insensitive,
 * substring-anchored — `bot_token`, `refresh_token`, `client_secret`,
 * etc. all match.
 */
export const SENSITIVE_KEY_PATTERN: RegExp =
  /token|secret|password|api[_-]?key|credential|authorization/i;

/**
 * Ordered list of secret-shape patterns. Order matters: more
 * specific patterns (PAT prefixes, JWTs, AWS keys) run before the
 * generic `Bearer` capture so the kind-attribution stays accurate
 * when, e.g., a PAT lives behind a Bearer header.
 *
 * All patterns are global so every occurrence is replaced in a
 * single `String.prototype.replace` pass (linear-time scan).
 */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  // Provider-specific personal access tokens / API keys. The trailing
  // character class is bounded by a non-token boundary (anything that
  // is NOT alnum / `_` / `-`) so the redaction does not eat into a
  // sentence that follows the token.
  { kind: "pat", regex: /\bdop_v1_[A-Za-z0-9]{32,}/g }, // DigitalOcean PAT
  { kind: "pat", regex: /\bghp_[A-Za-z0-9]{30,}/g }, // GitHub personal
  { kind: "pat", regex: /\bgho_[A-Za-z0-9]{30,}/g }, // GitHub OAuth user-to-server
  { kind: "pat", regex: /\bghu_[A-Za-z0-9]{30,}/g }, // GitHub user-to-server (legacy)
  { kind: "pat", regex: /\bghs_[A-Za-z0-9]{30,}/g }, // GitHub server-to-server
  { kind: "pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g }, // GitLab PAT
  { kind: "pat", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g }, // Anthropic API key
  // OpenAI / generic `sk-...` — bounded length so we don't false-match
  // every "sk-" prefix in normal text.
  { kind: "pat", regex: /\bsk-[A-Za-z0-9]{20,}/g },
  { kind: "pat", regex: /\bxoxb-[A-Za-z0-9-]{20,}/g }, // Slack bot
  { kind: "pat", regex: /\bxoxp-[A-Za-z0-9-]{20,}/g }, // Slack user
  // AWS access key id — fixed shape `AKIA` + 16 upper alnum.
  { kind: "aws_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT — three base64url segments separated by `.`. Anchor on the
  // mandatory `eyJ` header prefix to avoid false-matching arbitrary
  // dotted base64 blobs.
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  // Bearer header. Captures `Bearer <token>` and replaces the whole
  // span (header + token) so the kind-attribution is unambiguous.
  { kind: "bearer", regex: /Bearer\s+[A-Za-z0-9._-]+/gi },
];

/**
 * Replace every secret-shape hit in `value` with the matching
 * `***REDACTED:<kind>***` marker. Linear-time: each pattern is a
 * single `replace` pass and patterns do not overlap-substitute.
 */
export function scrubString(value: string): string {
  let out = value;
  for (const { kind, regex } of SECRET_PATTERNS) {
    if (out.indexOf("REDACTED:") !== -1 && !regex.test(out)) {
      // Fast path — already-redacted strings without any further hit
      // skip the rebuild. Cheap test, large saving on rescans.
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

function scrubValue(input: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;
  if (depth >= MAX_DEPTH) return "[depth-exceeded]";

  const obj = input as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(input)) {
    return input.map((item) => scrubValue(item, depth + 1, seen));
  }

  // Plain object — walk entries. For sensitive keys, redact the
  // string value entirely (not just shape-matched substrings); for
  // non-sensitive keys, recurse so nested shape hits are still caught.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === "string") {
      // Idempotent: if the legacy redactor (or a previous scrubber
      // pass) already replaced the value with a redaction marker,
      // leave the existing marker in place. Otherwise emit the
      // shape-attributed marker.
      out[key] = isAlreadyRedacted(value) ? value : REDACTED("key_value");
    } else {
      out[key] = scrubValue(value, depth + 1, seen);
    }
  }
  return out;
}

function isAlreadyRedacted(value: string): boolean {
  // Match both the legacy `***redacted***` and the new
  // `***REDACTED:<kind>***` markers. The check is case-insensitive
  // on the leading `redacted` so future marker variants stay
  // covered without another patch.
  return /^\*\*\*redacted(?::[a-z_]+)?\*\*\*$/i.test(value);
}

/**
 * Recursively scrub `payload` for secret-shape values and sensitive
 * key names. The input is never mutated; a new structure is returned
 * with redactions applied.
 *
 * Pure: no I/O, no throws. Cycle-safe: circular references are
 * replaced with the literal string `"[circular]"`. Depth-limited to
 * 16 levels to keep pathological inputs bounded.
 */
export function scrubSecrets(payload: unknown): unknown {
  return scrubValue(payload, 0, new WeakSet<object>());
}
