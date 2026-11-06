import type { WorkflowAuthority } from "@shared/workflow-automation.ts";
import type { Executor } from "../db/client.ts";
import type { workflowExecutionAuthorities } from "../db/schema/index.ts";
import { contentBoundariesFromManifest } from "./content-publication-proposal.ts";
import { isOpenEnded, remainingRuns } from "./core/authority.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import type { WorkflowReadFacts } from "./read-facts.ts";
import { reportBoundariesFromManifest } from "./report-delivery-proposal.ts";

export function recordedAuthority(
  row: typeof workflowExecutionAuthorities.$inferSelect,
  workflow: { lifecycle: string; current_version_id: string | null } | undefined,
  now: Date,
): WorkflowAuthority {
  const active_version =
    workflow?.lifecycle === "active" && workflow.current_version_id === row.workflow_version_id;
  const state: WorkflowAuthority["state"] = row.superseded_by
    ? "superseded"
    : row.revoked_at
      ? "revoked"
      : row.valid_until !== null && row.valid_until <= new Date(now)
        ? "expired"
        : row.max_runs !== null && row.reserved_runs >= row.max_runs
          ? "exhausted"
          : row.valid_from > new Date(now)
            ? "not_yet_valid"
            : "approved";
  return {
    execution_environment: row.execution_environment,
    active_version,
    ready_for_new_run: active_version && state === "approved",
    state,
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    remaining_runs: remainingRuns(row),
    max_runs: row.max_runs,
    reserved_runs: row.reserved_runs,
  };
}

export async function observeWorkflowAuthority(
  db: Executor,
  row: typeof workflowExecutionAuthorities.$inferSelect,
  workflow: { lifecycle: string; current_version_id: string | null } | undefined,
  now: Date,
  facts?: WorkflowReadFacts,
) {
  const { tenant_id, workflow_id } = row;
  const recorded = recordedAuthority(row, workflow, now);
  const active_version = recorded.active_version;
  let state: WorkflowAuthority["state"] = recorded.state;
  if (state === "approved" || state === "not_yet_valid") {
    try {
      const current = await previewWorkflowAuthority(
        {
          tenant_id,
          workflow_id,
          workflow_version_id: row.workflow_version_id,
          execution_environment: row.execution_environment,
        },
        db,
        {
          facts,
          report_boundaries: reportBoundariesFromManifest(row.effect_manifest),
          content_boundaries: contentBoundariesFromManifest(row.effect_manifest),
        },
      );
      if (current.digest !== row.effect_manifest_digest) state = "invalidated";
      else if (!current.eligible_for_repeated_runs) state = "unavailable";
    } catch (error) {
      if ((error as { code?: string }).code !== "workflow_version_unavailable") throw error;
      state = "invalidated";
    }
  }
  return {
    ...row,
    state,
    active_version,
    ready_for_new_run: active_version && state === "approved",
    remaining_runs: remainingRuns(row),
    open_ended: isOpenEnded(row),
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}
