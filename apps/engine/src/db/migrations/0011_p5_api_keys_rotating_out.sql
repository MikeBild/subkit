-- P5 follow-up: dedicated `rotating_out_at` column for api_keys.
--
-- Previously the rotation overlap window was compressed into `expires_at`,
-- which conflated "key has a hard expiry" with "key is being phased out
-- after a rotation". Splitting the two lets us keep `expires_at` as the
-- caller-supplied lifetime while the auth provider treats `rotating_out_at`
-- as a soft, post-rotation cutoff.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotating_out_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_keys_rotating_out_at_idx
  ON api_keys (rotating_out_at)
  WHERE rotating_out_at IS NOT NULL;
