import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "../db/schema/index.ts";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import type { ScheduleRow } from "./repo.ts";

/**
 * A schedule on a workflow that is not active, or has no committed version,
 * cannot start a run: the one predicate behind `activation_required` here and
 * behind a schedule binding's state on the workflow representation.
 */
export function scheduleNeedsActivation(
  workflow: { lifecycle: string; current_version_id: string | null } | null | undefined,
): boolean {
  return workflow?.lifecycle !== "active" || !workflow.current_version_id;
}

/** Observed readiness only: never reserves a run, grants authority or executes. */
async function inspectScheduleAutomationChecked(schedule: ScheduleRow, db: Executor) {
  const base = { schedule_id: schedule.id, workflow_id: schedule.workflow_id };
  if (schedule.paused) return { ...base, state: "paused", ready: false } as const;
  const [workflow] = await db
    .select({ version: workflows.current_version_id, lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, schedule.tenant_id),
        eq(workflows.id, schedule.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (
    !workflow?.version ||
    scheduleNeedsActivation({
      lifecycle: workflow.lifecycle,
      current_version_id: workflow.version,
    })
  )
    return { ...base, state: "activation_required", ready: false } as const;
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, schedule.tenant_id),
        eq(workflowVersions.workflow_id, schedule.workflow_id),
        eq(workflowVersions.id, workflow.version),
      ),
    )
    .limit(1);
  const definition = WorkflowDefSchema.parse(version?.dag);
  if (
    definition.input_schema &&
    !validateAgainstJsonSchema(
      normalizeWorkflowRunInput(schedule.input) ?? null,
      definition.input_schema,
      "$input",
    ).valid
  )
    return { ...base, state: "input_required", ready: false } as const;
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: schedule.tenant_id,
      workflow_id: schedule.workflow_id,
      workflow_version_id: workflow.version,
      execution_environment: schedule.execution_mode,
    },
    db,
  );
  if (!preview.eligible_for_repeated_runs)
    return {
      ...base,
      state: "repair_required",
      ready: false,
      unavailable_steps: preview.unavailable_steps,
      issues: preview.manifest.issues,
    } as const;
  const [authority] = await db
    .select({ id: workflowExecutionAuthorities.id })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, schedule.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, schedule.workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, workflow.version),
        eq(workflowExecutionAuthorities.execution_environment, schedule.execution_mode),
        eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
        isNull(workflowExecutionAuthorities.revoked_at),
        sql`${workflowExecutionAuthorities.valid_from} <= clock_timestamp()`,
        sql`${workflowExecutionAuthorities.valid_until} > clock_timestamp()`,
        sql`${workflowExecutionAuthorities.reserved_runs} < ${workflowExecutionAuthorities.max_runs}`,
      ),
    )
    .limit(1);
  return {
    ...base,
    state: authority ? "authorized" : "approval_required",
    ready: Boolean(authority),
    workflow_version_id: workflow.version,
  } as const;
}

export async function inspectScheduleAutomation(schedule: ScheduleRow, db: Executor) {
  try {
    return await inspectScheduleAutomationChecked(schedule, db);
  } catch {
    // An unavailable definition or connector is not evidence of readiness.
    return {
      schedule_id: schedule.id,
      workflow_id: schedule.workflow_id,
      state: "verification_unavailable",
      ready: false,
    } as const;
  }
}
