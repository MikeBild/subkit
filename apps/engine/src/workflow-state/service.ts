// Persistent per-workflow state service (#51).
//
// Read / write tenant-encrypted JSON values keyed by
// `(tenant_id, workflow_id, key)`. The step-runner calls these around a
// request step that declares `state_read` / `state_write`, with both the
// step result and the state write committed in a single transaction so a
// crash between cannot leave the watermark and the side-effect divergent.
//
// Encryption: AES-256-GCM via `crypto/aes-gcm.ts`. AAD binds each row to
// `tenant_id:workflow_id:key`. The plaintext is `JSON.stringify(value)`
// so any JSON-serialisable value round-trips losslessly.

import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { workflowRunState } from "../db/schema/workflow_run_state.ts";

export interface WorkflowStateRow {
  key: string;
  value: unknown;
  value_kind: string | null;
  updated_at: Date;
}

function aad(tenant_id: string, workflow_id: string, key: string): string {
  return `${tenant_id}:${workflow_id}:${key}`;
}

function inferKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Read a single state value for `(tenant_id, workflow_id, key)`. Returns
 * `undefined` when the row does not exist — the step-runner falls back
 * to `state_read.default_value` in that case (e.g. first run of a
 * cursor-based reverse-ETL workflow).
 *
 * Decrypt failures throw and propagate — a failed AAD verification is a
 * tenant-leakage signal, never silently swallowed.
 */
export async function readWorkflowState(
  db: Db,
  tenant_id: string,
  workflow_id: string,
  key: string,
): Promise<WorkflowStateRow | undefined> {
  const rows = await db
    .select()
    .from(workflowRunState)
    .where(
      and(
        eq(workflowRunState.tenant_id, tenant_id),
        eq(workflowRunState.workflow_id, workflow_id),
        eq(workflowRunState.key, key),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const plaintext = decryptSecret(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      auth_tag: row.auth_tag,
    },
    aad(tenant_id, workflow_id, key),
  );
  return {
    key,
    value: JSON.parse(plaintext) as unknown,
    value_kind: row.value_kind,
    updated_at: row.updated_at,
  };
}

/**
 * Upsert a state value. The encryption AAD binds the ciphertext to the
 * `(tenant_id, workflow_id, key)` triple, so a stolen ciphertext cannot
 * be lifted into another row.
 *
 * Caller is responsible for running this inside the same transaction as
 * the request step's persistence so a crash in between cannot leave the
 * watermark and the side-effect inconsistent.
 */
export async function writeWorkflowState(
  db: Db,
  p: {
    tenant_id: string;
    workflow_id: string;
    key: string;
    value: unknown;
  },
): Promise<void> {
  const plaintext = JSON.stringify(p.value);
  const enc = encryptSecret(plaintext, aad(p.tenant_id, p.workflow_id, p.key));
  const value_kind = inferKind(p.value);
  await db
    .insert(workflowRunState)
    .values({
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      key: p.key,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      auth_tag: enc.auth_tag,
      value_kind,
    })
    .onConflictDoUpdate({
      target: [workflowRunState.tenant_id, workflowRunState.workflow_id, workflowRunState.key],
      set: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        auth_tag: enc.auth_tag,
        value_kind,
        updated_at: new Date(),
      },
    });
}
