// Canonical structured `error_code` constants for the elicitation /
// OAuth conversation-tool paths.
//
// These strings are load-bearing in two places at once: the tool body
// that returns `{ ok: false, error_code }` AND the consecutive-failures
// cap catalogue (`sdk-wrap/error-recovery-hints.ts#ERROR_CODE_ALTERNATIVES`)
// that names the recovery path for each code. A typo on one side
// silently drops the recovery hint. Owning them here keeps the producer
// and the catalogue in lock-step — same pattern as
// `DRAFT_WRITE_MCP_UNAVAILABLE_REASON` in `tools/policy.ts`.

/** The user declined to start the OAuth authorization. */
export const OAUTH_AUTHORIZATION_DECLINED = "oauth_authorization_declined";

/** The MCP elicitation carrying the OAuth authorization URL failed in
 *  transit; the authorization state row is still live for a retry. */
export const OAUTH_ELICITATION_TRANSPORT_FAILED = "oauth_elicitation_transport_failed";

/** A generic `ask_user_*` MCP elicitation failed in transit (client
 *  disconnected or never answered). */
export const ELICITATION_TRANSPORT_FAILED = "elicitation_transport_failed";

/** The elicitation was already resolved through another channel — a
 *  concurrent `respondElicitation` won the race. */
export const ELICITATION_ALREADY_RESOLVED = "elicitation_already_resolved";
