-- G6 (runtime-logs review plan): track the OAuth scopes the engine
-- REQUESTED versus the scopes the IdP actually GRANTED.
--
-- Pre-fix the engine had no record of either — the connector template
-- defined a default scope set, the LLM could (and did) narrow it
-- per-call without that narrowing being persisted, and the IdP's
-- response was discarded after the credential row was written. The
-- effect: a Google OAuth flow that succeeded with only `drive.readonly`
-- (because the engine asked for nothing else, or because the user
-- granted only that scope on the consent screen) was indistinguishable
-- from a flow that succeeded with all three scopes the connector
-- template declares (gmail.readonly + calendar.readonly + drive.readonly).
-- Subsequent calls against the un-granted APIs returned 401, the model
-- chased wrong hypotheses, and ~10 min of session ed20f48d burned on a
-- "partial grant" the engine could not diagnose.
--
-- Both columns are nullable so existing rows survive unchanged and the
-- callback handler can be rolled out independently of the schema.
-- The diff happens in the callback handler — when `granted_scopes` is
-- a strict subset of `requested_scopes`, the connector is marked
-- `partial_grant` and `probe_connector` / `test_connector` surface
-- the missing scopes to the LLM.

ALTER TABLE connector_oauth_states ADD COLUMN requested_scopes text;
ALTER TABLE credentials ADD COLUMN granted_scopes text;
