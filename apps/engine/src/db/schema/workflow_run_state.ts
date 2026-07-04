// Persistent per-workflow state for cross-run cursors / watermarks.
//
// The `workflow_run_state` table stores tenant-encrypted JSON values keyed
// by `(tenant_id, workflow_id, key)`. Reverse-ETL workflows read a cursor
// at the start of each run, advance it during the run, and write it back
// at the end — all without leaking the cursor to external connectors.
//
// Encryption: AES-256-GCM via `crypto/aes-gcm.ts` with per-row AAD bound
// to `tenant_id:workflow_id:key`. A ciphertext can never be lifted from
// one row and replayed under another row's identity.
//
// PK: UUID surrogate. Uniqueness on `(tenant_id, workflow_id, key)`. This
// follows the canonical schema pattern (see `db/schema/_common.ts`); no
// natural composite PK.

import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

export const workflowRunState = pgTable(
  "workflow_run_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    workflow_id: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // Encrypted payload. Plaintext is the JSON-stringified value the
    // step wrote. AAD = `${tenant_id}:${workflow_id}:${key}`.
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    // Author-time metadata. Used by the inspector to surface the value
    // shape without decrypting (e.g. "string" / "number" / "object").
    // Never holds the plaintext.
    value_kind: text("value_kind"),
    // Audit-friendly free-text label set by the writer. Not load-bearing.
    note: jsonb("note").$type<Record<string, unknown> | null>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workflow_run_state_tenant_workflow_key_uniq").on(
      t.tenant_id,
      t.workflow_id,
      t.key,
    ),
    index("workflow_run_state_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
  ],
);
