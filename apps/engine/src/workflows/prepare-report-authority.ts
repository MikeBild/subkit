import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { runExecution } from "../execution/engine.ts";
import { listSchedules } from "../scheduler/repo.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";

/**
 * Run this workflow once with every write held, so the review has something to
 * read.
 *
 * A held run resolves each step's real target and content and records both. For
 * a report that is how the recipient is observed; for any other unbounded step
 * it is the evidence the boundary derivation needs, and for a step that sends
 * content it is the only place its size is written down.
 *
 * It used to run ONLY for the report profile and return silently otherwise —
 * while the endpoint above answered `prepared: true` either way. A reviewer was
 * told the preparation had happened, five workflows produced no run at all, and
 * the derivation that depended on it reported "these steps have never run".
 * The result now says which of the two happened.
 *
 * This cannot activate a version, send a message or create an execution grant.
 */
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
  if (preview.eligible_for_repeated_runs) return { prepared: false, reason: "already_bindable" };
  // A held run helps whenever something is unbound: the report profile asks for
  // it by name, and every other refused step needs exactly the same evidence.
  if (!preview.preparation_required && (preview.manifest?.issues?.length ?? 0) === 0)
    return { prepared: false, reason: "nothing_to_prepare" };
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
  return { prepared: true as const };
}
