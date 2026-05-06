-- Add `token_mint` to the credential_mode enum (A4). Generalises
-- non-OAuth2 username/password→JWT flows: Cognito InitiateAuth, Firebase
-- Auth REST signInWithPassword, generic POST /login. Persists like
-- oauth2 (cached access_token + optional refresh_token + expires_at)
-- but mints via a per-shape JSON / form / AWS-target POST.

ALTER TYPE "credential_mode" ADD VALUE IF NOT EXISTS 'token_mint';
