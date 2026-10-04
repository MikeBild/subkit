import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { patchCandidates } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { closeIfUndecidable } from "./open-decisions.ts";

export interface PersistPatchCandidateInput {
  tenant_id: string;
  workflow_id: string;
  connector_id: string | null;
  endpoint_key: string | null;
  classification: "safe" | "unsafe";
  fixture_id?: string | null;
  diff: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
  event_payload: Record<string, unknown>;
  log_fields?: Record<string, unknown>;
}

export async function persistPatchCandidate(tx: Executor, input: PersistPatchCandidateInput) {
  const [candidate] = await tx
    .insert(patchCandidates)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      connector_id: input.connector_id,
      endpoint_key: input.endpoint_key,
      classification: input.classification,
      ...(input.fixture_id ? { fixture_id: input.fixture_id } : {}),
      diff: input.diff,
      status: "proposed",
    })
    .returning();
  assertInsertRow(candidate, "patch_candidates");
  const closed = await closeIfUndecidable(tx, candidate, "proposal");
  if (closed) return { candidate, closed };
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: "system",
      action: AuditAction.PATCH_CANDIDATE_PROPOSED,
      resource_type: "patch_candidate",
      resource_id: candidate.id,
      result: "success",
      metadata: {
        workflow_id: input.workflow_id,
        classification: input.classification,
        ...input.audit_metadata,
      },
    },
    tx,
  );
  log.selfHealing.patch.proposed({
    candidate_id: candidate.id,
    workflow_id: input.workflow_id,
    tenant_id: input.tenant_id,
    classification: input.classification,
    ...input.log_fields,
  });
  await writeEvent(tx, {
    tenant_id: input.tenant_id,
    channel: "notification.emitted",
    type: "patch.proposed",
    payload: {
      patch_candidate_id: candidate.id,
      workflow_id: input.workflow_id,
      classification: input.classification,
      ...input.event_payload,
    },
  });
  return { candidate, closed };
}
