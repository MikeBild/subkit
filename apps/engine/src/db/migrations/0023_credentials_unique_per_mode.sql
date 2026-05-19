-- Allow multiple credential rows per (connector, environment) distinguished by mode.
-- RFC 7591 dynamic client registration stores `client_id` + encrypted `client_secret`
-- as a separate `oauth2_client` credential that must coexist with the user-facing
-- `oauth2` access token row; otherwise the OAuth callback's `upsertCredential` would
-- overwrite the registered client identity, leaving the refresh-token grant unable
-- to authenticate against the IdP's token endpoint for confidential clients.

DROP INDEX IF EXISTS "credentials_connector_env_key";
CREATE UNIQUE INDEX "credentials_connector_env_mode_key" ON "credentials" ("connector_id", "environment", "mode");
