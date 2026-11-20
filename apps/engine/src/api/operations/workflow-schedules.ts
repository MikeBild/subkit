import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  type ScheduleRow,
  updateSchedule,
} from "../../scheduler/repo.ts";
import { getWorkflow } from "../../workflows/service.ts";
import type { WorkflowView } from "../../workflows/view.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";
import { automationReadinessFor } from "./workflow-automation-readiness.ts";
import {
  ScheduleCreateBody,
  ScheduleDeleteResponse,
  ScheduleListResponse,
  ScheduleUpdateBody,
  ScheduleUpsertResponse,
  ScheduleWriteResponse,
} from "./workflow-schedule-representation.ts";

const ListSchedulesQuery = z
  .object({ workflow_id: z.string().uuid().optional() })
  .openapi("ListSchedulesQuery");

type ScheduleCreate = z.infer<typeof ScheduleCreateBody>;
type ScheduleUpdate = z.infer<typeof ScheduleUpdateBody>;
type Readiness = Awaited<ReturnType<typeof automationReadinessFor>>;

const preparedVersionId = (
  wf: { draft_version_id?: string | null; current_version_id: string | null } | null | undefined,
) =>
  wf?.draft_version_id && wf.draft_version_id !== wf.current_version_id
    ? wf.draft_version_id
    : null;

function scheduleEntry(row: ScheduleRow, wf: WorkflowView | null | undefined, held: boolean) {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    workflow_slug: wf?.slug ?? null,
    workflow_name: wf?.name ?? null,
    prepared_version_id: preparedVersionId(wf),
    admission_hold: held ? row.admission_hold : null,
    input_error: row.paused ? null : row.input_error,
    cron: row.cron,
    timezone: row.timezone,
    execution_mode: row.execution_mode,
    paused: row.paused,
    auto_pause:
      row.paused && row.paused_reason && row.paused_at
        ? {
            paused_reason: row.paused_reason,
            failure_class: row.paused_failure_class ?? "unclassified",
            consecutive_failures: row.paused_failure_count ?? 1,
            since: row.paused_at.toISOString(),
          }
        : null,
    input: row.input ?? null,
    created_at: row.created_at.toISOString(),
  };
}

async function serializeSchedule(db: Db, tenant_id: string, row: ScheduleRow) {
  const wf = await getWorkflow(tenant_id, row.workflow_id, db);
  return scheduleEntry(row, wf, !(row.paused || !wf || wf.lifecycle === "archived"));
}

function scheduleRejection(err: unknown): Rejection {
  const code = (err as { code?: string } | null)?.code;
  if (code === "invalid_cron") {
    return reject.badRequest(err instanceof Error ? err.message : "invalid cron");
  }
  if (code === "input_schema_violation") {
    const details = (err as { details?: unknown } | null)?.details;
    return reject.badRequest(
      err instanceof Error ? err.message : "schedule input does not match the active workflow",
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined,
    );
  }
  if (code === "workflow_not_found") return reject.notFound("workflow");
  if (code === "workflow_archived") {
    return reject.conflict(err instanceof Error ? err.message : "workflow is archived");
  }
  throw err;
}

async function scheduleReadiness(db: Db, tenant_id: string, row: ScheduleRow): Promise<Readiness> {
  if (row.paused) return undefined;
  return automationReadinessFor(
    db,
    tenant_id,
    await getWorkflow(tenant_id, row.workflow_id, db),
    "schedule_write",
    row.execution_mode,
  );
}

export const listSchedulesOperation = defineOperation<
  { workflow_id?: string },
  z.infer<typeof ScheduleListResponse>
>({
  id: "schedules.list",
  summary: "List scheduled workflow runs (cron, timezone, paused)",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, { workflow_id }) {
    const { rows, total } = await listSchedules(scope.db, scope.tenant_id, workflow_id);
    const ids = [...new Set(rows.map((r) => r.workflow_id))];
    const named = ids.length
      ? await Promise.all(ids.map((id) => getWorkflow(scope.tenant_id, id, scope.db)))
      : [];
    const nameById = new Map(named.filter((w) => w !== null).map((w) => [w.id, w]));
    return {
      schedules: rows.map((r) =>
        scheduleEntry(
          r,
          nameById.get(r.workflow_id),
          !(r.paused || !named.find((w) => w?.id === r.workflow_id && w.lifecycle !== "archived")),
        ),
      ),
      total,
    };
  },
  http: {
    method: "get",
    path: "/v1/schedules",
    tags: ["workflows"],
    query: ListSchedulesQuery,
    response: ScheduleListResponse,
    toInput: ({ query }) => query as { workflow_id?: string },
    toBody: (result) => result,
  },
});

interface ScheduleUpsertResult {
  readonly created: boolean;
  readonly body: Record<string, unknown>;
}

export const createScheduleOperation = defineOperation<ScheduleCreate, ScheduleUpsertResult>({
  id: "schedules.create",
  summary: "Schedule a workflow (upserts the workflow's single schedule)",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.SCHEDULE_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    let outcome: Awaited<ReturnType<typeof createSchedule>>;
    try {
      outcome = await createSchedule(scope.db, {
        tenant_id: scope.tenant_id,
        workflow_id: body.workflow_id,
        cron: body.cron,
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
      });
    } catch (err) {
      return scheduleRejection(err);
    }
    const { row, status } = outcome;
    await auditAwait(
      {
        tenant_id: scope.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: status === "created" ? AuditAction.SCHEDULE_CREATED : AuditAction.SCHEDULE_UPDATED,
        resource_type: "schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          cron: row.cron,
          timezone: row.timezone,
          execution_mode: row.execution_mode,
          paused: row.paused,
          kind: status,
          input_changed: body.input !== undefined,
        },
      },
      scope.db,
    );
    const readiness = await scheduleReadiness(scope.db, scope.tenant_id, row);
    return {
      created: status === "created",
      body: {
        ...(await serializeSchedule(scope.db, scope.tenant_id, row)),
        upsert_status: status,
        ...(readiness ? { automation_readiness: readiness } : {}),
      },
    };
  },
  http: {
    method: "post",
    path: "/v1/schedules",
    tags: ["workflows"],
    body: ScheduleCreateBody,
    response: ScheduleUpsertResponse,
    success: [
      { status: 200, description: "Existing workflow schedule updated" },
      { status: 201, description: "Schedule created" },
    ],
    statusFor: (result) => (result.created ? 201 : 200),
    errors: { 400: "Invalid cron", 404: "Workflow not found", 409: "Workflow is archived" },
    toInput: ({ json }) => json as ScheduleCreate,
    toBody: (result) => result.body,
  },
});

interface ScheduleUpdateInput {
  readonly id: string;
  readonly patch: ScheduleUpdate;
}

export const updateScheduleOperation = defineOperation<
  ScheduleUpdateInput,
  Record<string, unknown>
>({
  id: "schedules.update",
  summary: "Update a schedule's cron, timezone, paused flag, or input",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.SCHEDULE_UPDATED,
  async handler(scope, { id, patch: body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    let row: ScheduleRow | null;
    try {
      row = await updateSchedule(scope.db, scope.tenant_id, id, {
        ...(body.cron !== undefined ? { cron: body.cron } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.input !== undefined ? { input: body.input } : {}),
      });
    } catch (err) {
      return scheduleRejection(err);
    }
    if (!row) return reject.notFound("schedule");
    await auditAwait(
      {
        tenant_id: scope.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.SCHEDULE_UPDATED,
        resource_type: "schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          patch: {
            ...(body.cron !== undefined ? { cron: body.cron } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
            ...(body.execution_mode !== undefined ? { execution_mode: body.execution_mode } : {}),
            ...(body.paused !== undefined ? { paused: body.paused } : {}),
            ...(body.input !== undefined ? { input: true } : {}),
          },
        },
      },
      scope.db,
    );
    const readiness = await scheduleReadiness(scope.db, scope.tenant_id, row);
    return {
      ...(await serializeSchedule(scope.db, scope.tenant_id, row)),
      ...(readiness ? { automation_readiness: readiness } : {}),
    };
  },
  http: {
    method: "put",
    path: "/v1/schedules/{id}",
    tags: ["workflows"],
    params: IdParam,
    body: ScheduleUpdateBody,
    response: ScheduleWriteResponse,
    errors: { 400: "Invalid cron", 404: "Schedule not found" },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      patch: json as ScheduleUpdate,
    }),
    toBody: (result) => result,
  },
});

export const deleteScheduleOperation = defineOperation<string, { id: string; deleted: true }>({
  id: "schedules.delete",
  summary: "Delete a schedule",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.SCHEDULE_DELETED,
  async handler(scope, id) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const before = await getSchedule(scope.db, scope.tenant_id, id);
    const ok = await deleteSchedule(scope.db, scope.tenant_id, id);
    if (!ok) return reject.notFound("schedule");
    await auditAwait(
      {
        tenant_id: scope.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.SCHEDULE_DELETED,
        resource_type: "schedule",
        resource_id: id,
        result: "success",
        metadata: { workflow_id: before?.workflow_id ?? null },
      },
      scope.db,
    );
    return { id, deleted: true };
  },
  http: {
    method: "delete",
    path: "/v1/schedules/{id}",
    tags: ["workflows"],
    params: IdParam,
    response: ScheduleDeleteResponse,
    errors: { 404: "Schedule not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: (result) => result,
  },
});
