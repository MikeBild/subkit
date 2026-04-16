-- Pass 2 A1: real OIDC provider state.
--
-- The OIDC provider is upgraded from the P2 stub to a full authorization
-- code + session cookie flow. Three schema changes support it:
--
-- 1. `oidc_login_states` — short-lived pending-login rows that carry the
--    PKCE verifier, state, nonce, and optional redirect_to target from
--    `GET /v1/identity/login/start` across the user-agent round trip
--    back into `GET /v1/identity/login/callback`. TTL is 10 minutes.
--
-- 2. `users.external_subject` — the issuer's `sub` claim, bound per
--    tenant. Unique (tenant_id, external_subject) partial index so that
--    a row without an external subject is still valid and two users on
--    different tenants can share a sub.
--
-- 3. `sessions.token_sha256` — the sha256 of the random 32-byte nonce
--    we embed in the signed session cookie. Lets the resolver look up
--    the session row without trusting the cookie payload directly.
--
-- None of these columns are backfilled — existing rows predate the
-- feature and continue to resolve via the legacy CLI id-token exchange
-- route.

CREATE TABLE IF NOT EXISTS "oidc_login_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid,
  "state" text NOT NULL,
  "code_verifier" text NOT NULL,
  "nonce" text NOT NULL,
  "redirect_to" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_login_states_state_key"
  ON "oidc_login_states" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_login_states_expires_idx"
  ON "oidc_login_states" ("expires_at");
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "external_subject" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_external_subject_key"
  ON "users" ("tenant_id", "external_subject")
  WHERE "external_subject" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "token_sha256" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_token_sha256_idx"
  ON "sessions" ("token_sha256");
