// Per-id correlation hash helper for structured logs.
//
// Operators correlate "did this turn see X?" by hashing X locally with
// the same algorithm and grepping the log line for the resulting 8-char
// prefix. Lists are capped at 12 entries (top-N selection cap plus
// headroom) so the log line stays bounded; no metric labels carry
// hashes — cardinality protection.
//
// Privacy framing: correlation-grade obfuscation, NOT a security
// boundary. Slugs and seeded ids may be guessable or operator-visible
// elsewhere; the hash gives bounded correlation only.

import { createHash } from "node:crypto";

/**
 * Cap a string-id list to `cap` entries (default 12) and map each
 * survivor to an 8-char sha256 hex prefix.
 */
export function idHashesCapped(ids: string[], cap = 12): string[] {
  return ids.slice(0, cap).map((id) => createHash("sha256").update(id).digest("hex").slice(0, 8));
}
