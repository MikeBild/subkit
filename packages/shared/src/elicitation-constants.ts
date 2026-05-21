// Constants shared between the engine and the CLI for the elicitation
// surface. The engine encodes these field names into elicitation
// payloads; the CLI keys on them to drive client-side behavior (e.g.
// auto-opening the OAuth authorization URL in a browser). Keeping the
// name in one place prevents the two sides from silently drifting apart.

/**
 * The field on an `ask_user_confirm` elicitation `input` payload that
 * carries the OAuth authorization URL. The engine's `authenticate_oauth`
 * tool sets it on the DB-pause elicitation; the CLI REPL keys on it to
 * detect the OAuth step and auto-open the browser.
 */
export const OAUTH_AUTHORIZATION_URL_FIELD = "authorization_url";
