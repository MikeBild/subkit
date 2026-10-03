import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  type webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import { authorityLive } from "../workflows/authority-live.ts";
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

/** What starts runs without a person: a schedule or an inbound hook. */
interface AutomationBinding {
  tenant_id: string;
  workflow_id: string;
  paused: boolean;
  environment: "dev" | "prod";
  /** The input every run starts with, when the binding fixes one. A hook's
   *  input is the delivery, unknown until it arrives — not checked. */
  input?: { value: unknown };
}

/** Observed readiness only: never reserves a run, grants authority or executes. */
async function inspectAutomationChecked<B extends object>(
  binding: AutomationBinding,
  base: B,
  db: Executor,
) {
  if (binding.paused) return { ...base, state: "paused", ready: false } as const;
  const [workflow] = await db
    .select({ version: workflows.current_version_id, lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, binding.tenant_id),
        eq(workflows.id, binding.workflow_id),
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
        eq(workflowVersions.tenant_id, binding.tenant_id),
        eq(workflowVersions.workflow_id, binding.workflow_id),
        eq(workflowVersions.id, workflow.version),
      ),
    )
    .limit(1);
  const definition = WorkflowDefSchema.parse(version?.dag);
  if (
    binding.input &&
    definition.input_schema &&
    !validateAgainstJsonSchema(
      normalizeWorkflowRunInput(binding.input.value) ?? null,
      definition.input_schema,
      "$input",
    ).valid
  )
    return { ...base, state: "input_required", ready: false } as const;
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: binding.tenant_id,
      workflow_id: binding.workflow_id,
      workflow_version_id: workflow.version,
      execution_environment: binding.environment,
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
        eq(workflowExecutionAuthorities.tenant_id, binding.tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, binding.workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, workflow.version),
        eq(workflowExecutionAuthorities.execution_environment, binding.environment),
        eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
        authorityLive(),
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

async function inspectAutomation<B extends object>(
  binding: AutomationBinding,
  base: B,
  db: Executor,
) {
  try {
    return await inspectAutomationChecked(binding, base, db);
  } catch {
    // An unavailable definition or connector is not evidence of readiness.
    return { ...base, state: "verification_unavailable", ready: false } as const;
  }
}

export function inspectScheduleAutomation(schedule: ScheduleRow, db: Executor) {
  return inspectAutomation(
    {
      tenant_id: schedule.tenant_id,
      workflow_id: schedule.workflow_id,
      paused: schedule.paused,
      environment: schedule.execution_mode,
      input: { value: schedule.input },
    },
    { schedule_id: schedule.id, workflow_id: schedule.workflow_id },
    db,
  );
}

/** An inbound hook, judged by the gate its deliveries meet: unattended
 *  deliveries only ever run in production (`webhooks/inbound/service.ts`). */
export function inspectInboundHookAutomation(
  hook: Pick<typeof webhooksInbound.$inferSelect, "id" | "tenant_id" | "workflow_id" | "active">,
  db: Executor,
) {
  return inspectAutomation(
    {
      tenant_id: hook.tenant_id,
      workflow_id: hook.workflow_id,
      paused: !hook.active,
      environment: "prod",
    },
    { inbound_hook_id: hook.id, workflow_id: hook.workflow_id },
    db,
  );
}
