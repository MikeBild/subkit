import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { runExecution } from "../execution/engine.ts";
import { listSchedules } from "../scheduler/repo.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";

/** Prepare an actual held delivery when its recipient has not been observed.
 * This cannot activate a version, send a message or create an execution grant. */
export async function prepareReportAuthority(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Db,
  principal: ResolvedPrincipal,
) {
  const preview = await previewWorkflowAuthority(input, db);
  if (preview.eligible_for_repeated_runs || !preview.preparation_required) return;
  const schedules = (await listSchedules(db, input.tenant_id, input.workflow_id)).rows.filter(
    (row) => row.execution_mode === input.execution_environment && !row.paused,
  );
  // Multiple distinct inputs need separate previews. Never silently pick one.
  if (schedules.length > 1)
    throw Object.assign(new Error("Review one schedule at a time"), {
      code: "authority_preparation_ambiguous",
    });
  const result = await runExecution({
    db,
    tenant_id: input.tenant_id,
    source: {
      kind: "saved",
      workflow_id: input.workflow_id,
      version_id: input.workflow_version_id,
    },
    input: schedules[0]?.input ?? {},
    options: {
      hold_writes: true,
      execution_mode: input.execution_environment,
      request_source: "ui",
      principal,
      self_healing: { enabled: false },
    },
  });
  if (result.status !== "succeeded")
    throw Object.assign(new Error("The preparation did not complete; external writes were held"), {
      code: "authority_preparation_failed",
    });
}
