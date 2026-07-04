// LLM-friendly JSON parse with automatic repair fallback.
//
// LLM-emitted JSON often has trailing commas, missing quotes, or unescaped
// newlines. `JSON.parse` rejects these; falling back to `jsonrepair` recovers
// most cases without the cost of an extra self-healing turn.
//
// Returns `undefined` if both raw parse and repair-then-parse fail. Callers
// should treat that as "not JSON" and surface a typed error to the operator.

import { jsonrepair } from "jsonrepair";

export function safeParseJson<T = unknown>(raw: string): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(raw)) as T;
    } catch {
      return undefined;
    }
  }
}

/**
 * Variant that distinguishes "raw parse worked" from "repair was needed".
 * Use when the caller wants to log the repair-rate or skip repair on a
 * trusted source.
 */
export function safeParseJsonWithMeta<T = unknown>(
  raw: string,
): { ok: true; value: T; repaired: boolean } | { ok: false } {
  if (!raw) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) as T, repaired: false };
  } catch {
    try {
      return { ok: true, value: JSON.parse(jsonrepair(raw)) as T, repaired: true };
    } catch {
      return { ok: false };
    }
  }
}
