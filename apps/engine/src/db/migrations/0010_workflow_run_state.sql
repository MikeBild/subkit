-- Persistent per-workflow state (#51). Cross-run watermarks / cursors,
-- tenant-encrypted, scoped to a single workflow.
--
-- Reverse-ETL workflows (or any incremental-sync pattern) read a cursor
-- at the start of a run, advance it, write it back at the end. Encrypting
-- via AES-256-GCM with `tenant_id:workflow_id:key` AAD prevents a
-- ciphertext from being lifted out of one row and replayed under another
-- row's identity.
--
-- PK is a UUID surrogate; uniqueness on `(tenant_id, workflow_id, key)`
-- — see db/schema/_common.ts for the canonical schema pattern.

CREATE TABLE IF NOT EXISTS "workflow_run_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "value_kind" text,
  "note" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_state_tenant_workflow_key_uniq"
  ON "workflow_run_state" ("tenant_id", "workflow_id", "key");

CREATE INDEX IF NOT EXISTS "workflow_run_state_tenant_workflow_idx"
  ON "workflow_run_state" ("tenant_id", "workflow_id");
