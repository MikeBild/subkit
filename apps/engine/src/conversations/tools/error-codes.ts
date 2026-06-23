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

/** An MCP `ask_user_*` elicitation came back with an `accept` action but
 *  an answer that violates the requested schema (an out-of-enum
 *  `ask_user_choice` value, a non-boolean `ask_user_confirm`). Treated as
 *  a decline rather than persisted as a partial. */
export const INVALID_ELICIT_RESPONSE = "invalid_elicit_response";

/** `waitForOAuthCredential` reached its upper bound with no callback —
 *  the authorization is still pending, not failed; the state row is live
 *  so a retry resumes the same flow. */
export const OAUTH_TIMEOUT = "oauth_timeout";

/** The OAuth authorization-code dance produced an explicit
 *  `callback_failed` signal — no credential was persisted. */
export const OAUTH_AUTHORIZATION_FAILED = "oauth_authorization_failed";

/** `authenticate_oauth` was called on a connector whose grant is NOT a
 *  browser authorization-code flow (Cognito USER_PASSWORD_AUTH or
 *  client_credentials_json). Those grants have no authorization endpoint, so
 *  starting the browser dance throws opaquely ("unexpected HTTP response
 *  status code"). The right path is `request_connector_reauth`, which
 *  re-collects the credential in chat and rotates it in place. */
export const WRONG_REAUTH_FLOW = "wrong_reauth_flow";
