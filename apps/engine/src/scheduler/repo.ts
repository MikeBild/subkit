import { and, asc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import type { ListResult } from "../db/list-result.ts";
import { workflows, workflowsSchedules, workflowVersions } from "../db/schema/index.ts";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import { chooseEnvironment } from "../identity/core/default-environment.ts";
import { personalDefaultEnvironment } from "../identity/setup-preferences.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import type { ScheduleTrigger } from "../workflows/types.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { stripCalendarGates } from "./calendar-gates.ts";
import { parseCronExpression } from "./cron.ts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export interface ScheduleRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  cron: string;
  timezone: string;
  paused: boolean;
  execution_mode: "dev" | "prod";
  admission_hold: typeof workflowsSchedules.$inferSelect.admission_hold;
  input_error: typeof workflowsSchedules.$inferSelect.input_error;
  input: unknown;
  last_enqueued_at: Date | null;
  paused_at: Date | null;
  paused_reason: "repeated_failures" | null;
  paused_failure_class: string | null;
  paused_failure_count: number | null;
  failures_reset_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type ScheduleCreator = Pick<ResolvedPrincipal, "kind" | "id" | "tenant_id">;

function creatorUserId(creator: ScheduleCreator): string | null {
  return creator.kind === "user" ? creator.id : null;
}

interface CreateScheduleInput {
  tenant_id: string;
  workflow_id: string;
  cron: string;
  timezone?: string;
  execution_mode?: "dev" | "prod";
  input?: unknown;
  paused?: boolean;
  creator: ScheduleCreator | null;
}

type CreateScheduleOutcome = {
  status: "created" | "updated";
  row: ScheduleRow;
};

export type ScheduleInputIssue = { path: string; message: string };

export type ScheduleInputError = {
  checked_version_id: string;
  issues: ScheduleInputIssue[];
};

function scheduleInputIssues(errors: string[]): ScheduleInputIssue[] {
  return errors.map((error) => {
    const separator = error.indexOf(": ");
    return separator === -1
      ? { path: "$input", message: error }
      : { path: error.slice(0, separator), message: error.slice(separator + 2) };
  });
}

export async function validateScheduleInput(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  input: unknown,
): Promise<ScheduleInputError | null> {
  const rows = await db
    .select({ version_id: workflows.current_version_id, dag: workflowVersions.dag })
    .from(workflows)
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, workflows.tenant_id),
        eq(workflowVersions.workflow_id, workflows.id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.version_id || !row.dag) return null;
  const definition = WorkflowDefSchema.parse(row.dag);
  if (!definition.input_schema) return null;
  const check = validateAgainstJsonSchema(
    normalizeWorkflowRunInput(stripCalendarGates(input), definition.input_schema),
    definition.input_schema,
    "$input",
  );
  return check.valid
    ? null
    : { checked_version_id: row.version_id, issues: scheduleInputIssues(check.errors) };
}

function invalidScheduleInput(input_error: ScheduleInputError): never {
  throw Object.assign(new Error("schedule input does not match the active workflow"), {
    code: "input_schema_violation",
    details: input_error,
  });
}

export async function createSchedule(
  db: Db,
  input: CreateScheduleInput,
): Promise<CreateScheduleOutcome> {
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, input.tenant_id);
    return createScheduleLocked(tx, input);
  });
}

export async function createScheduleLocked(
  db: Executor,
  input: CreateScheduleInput,
): Promise<CreateScheduleOutcome> {
  const parsed = parseCronExpression(input.cron);
  if (!parsed.ok) {
    throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
      code: "invalid_cron",
      reason: parsed.reason,
    });
  }
  const wf = await db
    .select({ id: workflows.id, lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, input.tenant_id),
        eq(workflows.id, input.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (wf.length === 0) {
    throw Object.assign(new Error("workflow_not_found"), { code: "workflow_not_found" });
  }
  if (wf[0]?.lifecycle === "archived") {
    throw Object.assign(
      new Error("workflow is archived; restore it to active before scheduling it"),
      { code: "workflow_archived" },
    );
  }
  const existing = await db
    .select({
      id: workflowsSchedules.id,
      input: workflowsSchedules.input,
      execution_mode: workflowsSchedules.execution_mode,
    })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, input.tenant_id),
        eq(workflowsSchedules.workflow_id, input.workflow_id),
      ),
    )
    .limit(1);
  const prior = existing[0] as
    | { id: string; input: unknown; execution_mode: "dev" | "prod" }
    | undefined;
  const scheduleInput = input.input === undefined ? (prior?.input ?? null) : input.input;
  const input_error = await validateScheduleInput(
    db,
    input.tenant_id,
    input.workflow_id,
    scheduleInput,
  );
  if (input_error) invalidScheduleInput(input_error);
  if (prior) {
    const updated = await db
      .update(workflowsSchedules)
      .set({
        cron: input.cron,
        timezone: input.timezone ?? "UTC",
        paused: input.paused ?? false,
        paused_at: null,
        paused_reason: null,
        paused_failure_class: null,
        paused_failure_count: null,
        failures_reset_at: new Date(),
        execution_mode: chooseEnvironment({
          requested: input.execution_mode,
          current: prior.execution_mode,
        }),
        input: scheduleInput as never,
        input_error: null,
        created_by: input.creator ? creatorUserId(input.creator) : null,
        updated_at: new Date(),
      })
      .where(
        and(eq(workflowsSchedules.tenant_id, input.tenant_id), eq(workflowsSchedules.id, prior.id)),
      )
      .returning();
    await scheduleChanged(db, updated[0] as ScheduleRow | undefined);
    return { status: "updated", row: updated[0] as ScheduleRow };
  }
  const rows = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      paused: input.paused ?? false,
      execution_mode: chooseEnvironment({
        requested: input.execution_mode,
        personal: await personalDefaultEnvironment(db, input.tenant_id, input.creator),
      }),
      input: scheduleInput as never,
      input_error: null,
      created_by: input.creator ? creatorUserId(input.creator) : null,
    })
    .returning();
  await scheduleChanged(db, rows[0] as ScheduleRow | undefined);
  return { status: "created", row: rows[0] as ScheduleRow };
}

async function scheduleChanged(
  db: Executor,
  row: { id: string; tenant_id: string; workflow_id: string } | undefined,
): Promise<void> {
  if (!row) return;
  await emitResourceChange(db, {
    tenant_id: row.tenant_id,
    type: "workflow.automation_changed",
    ids: { workflow_id: row.workflow_id, schedule_id: row.id },
  });
}

export async function listSchedules(
  db: Db,
  tenant_id: string,
  workflow_id?: string,
): Promise<ListResult<ScheduleRow>> {
  const tenantConds = [eq(workflowsSchedules.tenant_id, tenant_id)];
  if (workflow_id) tenantConds.push(eq(workflowsSchedules.workflow_id, workflow_id));
  const rows = (await db
    .select()
    .from(workflowsSchedules)
    .where(and(...tenantConds))
    .orderBy(asc(workflowsSchedules.created_at), asc(workflowsSchedules.id))) as ScheduleRow[];
  return { rows, total: rows.length };
}

export async function getSchedule(
  db: Executor,
  tenant_id: string,
  id: string,
): Promise<ScheduleRow | null> {
  const rows = await db
    .select()
    .from(workflowsSchedules)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .limit(1);
  return (rows[0] as ScheduleRow | undefined) ?? null;
}

interface UpdateScheduleInput {
  cron?: string;
  timezone?: string;
  execution_mode?: "dev" | "prod";
  paused?: boolean;
  input?: unknown;
  created_by?: string | null;
}

export async function updateSchedule(
  db: Db,
  tenant_id: string,
  id: string,
  patch: UpdateScheduleInput,
): Promise<ScheduleRow | null> {
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
    return updateScheduleLocked(tx, tenant_id, id, patch);
  });
}

async function updateScheduleLocked(
  db: Executor,
  tenant_id: string,
  id: string,
  patch: UpdateScheduleInput,
): Promise<ScheduleRow | null> {
  if (patch.cron !== undefined) {
    const parsed = parseCronExpression(patch.cron);
    if (!parsed.ok) {
      throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
        code: "invalid_cron",
        reason: parsed.reason,
      });
    }
  }
  const existing = await getSchedule(db, tenant_id, id);
  if (!existing) return null;
  const nextInput = patch.input === undefined ? existing.input : patch.input;
  const input_error = await validateScheduleInput(db, tenant_id, existing.workflow_id, nextInput);
  if (input_error) invalidScheduleInput(input_error);
  const set: Record<string, unknown> = {
    updated_at: new Date(),
    input_error: null,
    ...(existing.admission_hold?.reason_code === "input_required" ? { admission_hold: null } : {}),
  };
  if (patch.cron !== undefined) set.cron = patch.cron;
  if (patch.timezone !== undefined) set.timezone = patch.timezone;
  if (patch.execution_mode !== undefined) set.execution_mode = patch.execution_mode;
  if (patch.paused !== undefined) {
    set.paused = patch.paused;
    set.paused_at = null;
    set.paused_reason = null;
    set.paused_failure_class = null;
    set.paused_failure_count = null;
    if (existing.paused && !patch.paused) set.failures_reset_at = new Date();
  }
  if (patch.input !== undefined) set.input = patch.input;
  if (patch.created_by !== undefined) set.created_by = patch.created_by;
  const rows = await db
    .update(workflowsSchedules)
    .set(set)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .returning();
  await scheduleChanged(db, rows[0] as ScheduleRow | undefined);
  return (rows[0] as ScheduleRow | undefined) ?? null;
}

export async function deleteSchedule(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(workflowsSchedules)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .returning({
      id: workflowsSchedules.id,
      tenant_id: workflowsSchedules.tenant_id,
      workflow_id: workflowsSchedules.workflow_id,
    });
  await scheduleChanged(db, rows[0]);
  return rows.length > 0;
}

interface BindScheduleFromWorkflowInput {
  tenant_id: string;
  workflow_id: string;
  trigger: ScheduleTrigger;
  actor_id: string | null;
  actor_type?: AuditActorType;
}

type BindScheduleOutcome =
  | { status: "created"; row: ScheduleRow }
  | { status: "updated"; row: ScheduleRow }
  | { status: "noop"; row: ScheduleRow };

function personOf(input: { actor_id: string | null; actor_type?: AuditActorType }): string | null {
  return input.actor_type === "user" ? input.actor_id : null;
}

export async function bindFromWorkflow(
  db: Executor,
  input: BindScheduleFromWorkflowInput,
): Promise<BindScheduleOutcome> {
  const parsed = parseCronExpression(input.trigger.cron);
  if (!parsed.ok) {
    throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
      code: "invalid_cron",
      reason: parsed.reason,
    });
  }
  const inputPayload = {
    business_days_only: input.trigger.business_days_only ?? false,
    skip_dates: input.trigger.skip_dates ?? [],
  };
  const tz = input.trigger.tz;

  const existingRows = await db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, input.tenant_id),
        eq(workflowsSchedules.workflow_id, input.workflow_id),
      ),
    )
    .limit(1);
  const prior = existingRows[0] as ScheduleRow | undefined;
  const executionMode = chooseEnvironment({
    requested: input.trigger.execution_mode,
    current: prior?.execution_mode,
    personal: prior
      ? null
      : await personalDefaultEnvironment(
          db,
          input.tenant_id,
          input.actor_type === "user" && input.actor_id
            ? { kind: "user", id: input.actor_id, tenant_id: input.tenant_id }
            : null,
        ),
  });

  if (prior) {
    const sameCron = prior.cron === input.trigger.cron;
    const sameTz = prior.timezone === tz;
    const sameExecutionMode = prior.execution_mode === executionMode;
    const sameInput = canonicalJson(prior.input ?? {}) === canonicalJson(inputPayload);
    if (sameCron && sameTz && sameExecutionMode && sameInput) {
      return { status: "noop", row: prior };
    }
    const updated = await db
      .update(workflowsSchedules)
      .set({
        cron: input.trigger.cron,
        timezone: tz,
        execution_mode: executionMode,
        input: inputPayload as never,
        created_by: personOf(input),
        updated_at: new Date(),
      })
      .where(
        and(eq(workflowsSchedules.tenant_id, input.tenant_id), eq(workflowsSchedules.id, prior.id)),
      )
      .returning();
    const row = (updated[0] as ScheduleRow | undefined) ?? prior;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor(input),
        action: AuditAction.SCHEDULE_TRIGGER_BOUND,
        resource_type: "workflow_schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: input.workflow_id,
          cron: input.trigger.cron,
          tz,
          execution_mode: executionMode,
          business_days_only: input.trigger.business_days_only ?? false,
          skip_date_count: (input.trigger.skip_dates ?? []).length,
          kind: "update",
        },
      },
      db,
    );
    return { status: "updated", row };
  }

  const inserted = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      cron: input.trigger.cron,
      timezone: tz,
      paused: false,
      execution_mode: executionMode,
      input: inputPayload as never,
      created_by: personOf(input),
    })
    .returning();
  const row = inserted[0] as ScheduleRow;
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      ...resolveActor(input),
      action: AuditAction.SCHEDULE_TRIGGER_BOUND,
      resource_type: "workflow_schedule",
      resource_id: row.id,
      result: "success",
      metadata: {
        workflow_id: input.workflow_id,
        cron: input.trigger.cron,
        tz,
        execution_mode: executionMode,
        business_days_only: input.trigger.business_days_only ?? false,
        skip_date_count: (input.trigger.skip_dates ?? []).length,
        kind: "create",
      },
    },
    db,
  );
  return { status: "created", row };
}

export async function unbindFromWorkflow(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  actor_id: string | null,
  actor_type?: AuditActorType,
): Promise<number> {
  const rows = await db
    .delete(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    )
    .returning({ id: workflowsSchedules.id });
  for (const row of rows) {
    await auditAwait(
      {
        tenant_id,
        ...resolveActor({
          tenant_id,
          actor_id,
          ...(actor_type !== undefined ? { actor_type } : {}),
        }),
        action: AuditAction.SCHEDULE_TRIGGER_UNBOUND,
        resource_type: "workflow_schedule",
        resource_id: row.id,
        result: "success",
        metadata: { workflow_id },
      },
      db,
    );
  }
  return rows.length;
}
