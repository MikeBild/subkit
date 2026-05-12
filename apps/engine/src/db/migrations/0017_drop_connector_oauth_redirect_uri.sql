-- 0017: strip `config.oauth.redirect_uri` from existing connectors.
--
-- Background: the v4.7.3 OAuth root-cause fix moved redirect_uri synthesis
-- server-side (apps/engine/src/credentials/oauth2/redirect-uri.ts). The
-- field is no longer accepted in the Zod config schema; live connector
-- rows that carry a stale value (typically an LLM-authored URL like
-- `http://<host>/oauth/callback` that never matched any real route) are
-- harmless at runtime — the resolver ignores them — but they break any
-- subsequent re-save once the strict schema kicks in. Drop the key in
-- one shot so the data and the schema converge.
--
-- jsonb_set with create_missing=false is a no-op when the key is
-- absent; `-` operator drops the key if it exists. Idempotent.

UPDATE connectors
SET config = jsonb_set(
  config,
  '{oauth}',
  (config -> 'oauth') - 'redirect_uri',
  false
)
WHERE config ? 'oauth'
  AND (config -> 'oauth') ? 'redirect_uri';
