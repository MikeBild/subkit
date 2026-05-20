-- Add `oauth2_client` to the credential_mode enum (RFC 7591 dynamic client
-- registration). Stores the dynamically-issued client_id + encrypted
-- client_secret so the oauth start handler can read them back without
-- writing plaintext onto connectors.config JSONB.

ALTER TYPE "credential_mode" ADD VALUE IF NOT EXISTS 'oauth2_client';
