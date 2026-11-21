import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import type { Db } from "../db/client.ts";
import { workflowRunState } from "../db/schema/workflow_run_state.ts";

interface WorkflowStateRow {
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
