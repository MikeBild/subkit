// Which channel a principal arrived through, as a stable string.
//
// Answers "which client opened this?" for anything that outlives the request —
// a conversation row, and through it every elicitation attached to it. Without
// it, an aggregate like "0 of 29 elicitations were ever fulfilled" cannot be
// split by client, and a per-channel decision has nothing to key on.
//
// CREDENTIAL-BOUND, NOT SELF-REPORTED. Every term comes from the credential the
// request authenticated with, never from the `clientInfo` a client sends at
// `initialize`. A client can name itself anything; it cannot name itself into
// another registration. That distinction is the whole point: this value is safe
// to base a decision on, `clientInfo` is only safe to log.
//
// Format is `<provider>:<credential-id>` so the provider stays readable in a
// query without a join, and the id keeps two clients on the same provider apart.

import type { ResolvedPrincipal } from "./types.ts";

/**
 * The channel reference for a principal, or `null` when the credential carries
 * no stable per-channel identity.
 *
 * `null` is meaningful rather than missing: a session-backed principal is a
 * person in a browser, not a registered client, so there is no channel to
 * attribute. Callers persist the null as-is instead of inventing a placeholder.
 */
export function principalOrigin(p: ResolvedPrincipal): string | null {
  if (p.api_key_id) return `api_key:${p.api_key_id}`;
  if (p.oauth_client_id) return `mcp_oauth:${p.oauth_client_id}`;
  if (p.session_id) return `${p.provider}:session`;
  return null;
}
