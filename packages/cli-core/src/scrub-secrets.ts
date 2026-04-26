// Secret-shape scrubber. Replaces well-known token shapes with
// `***REDACTED:<kind>***` everywhere a payload can be serialized to a
// log line, audit row, or `~/.sk/debug.log` entry.
//
// This module is the gate between sensitive data and any disk / wire
// surface. Callers must apply it at the entry point of each sink so
// that downstream serialization can never accidentally bypass it.
//
// Mirrored from `apps/engine/src/logging/scrub-secrets.ts` so the
// `sk` CLI can scrub before writing to `~/.sk/debug.log` without
// pulling in engine-private code. The two copies must stay in sync —
// any change to one MUST be applied to the other in the same commit.
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

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key) && typeof value === "string") {
      out[key] = isAlreadyRedacted(value) ? value : REDACTED("key_value");
    } else {
      out[key] = scrubValue(value, depth + 1, seen);
    }
  }
  return out;
}

function isAlreadyRedacted(value: string): boolean {
  return /^\*\*\*redacted(?::[a-z_]+)?\*\*\*$/i.test(value);
}

export function scrubSecrets(payload: unknown): unknown {
  return scrubValue(payload, 0, new WeakSet<object>());
}
