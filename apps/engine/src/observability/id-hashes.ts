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

/** Bounded list of survivors that may appear in a single log line. */
const LOG_LIST_CAP = 12;

/**
 * Cap a string-id list to 12 entries and map each survivor to an 8-char
 * sha256 hex prefix. The cap mirrors the top-N selection cap in the
 * assembler plus headroom — keeping log lines bounded and metric labels
 * collision-free.
 */
export function idHashesCapped(ids: string[]): string[] {
  return ids
    .slice(0, LOG_LIST_CAP)
    .map((id) => createHash("sha256").update(id).digest("hex").slice(0, 8));
}
