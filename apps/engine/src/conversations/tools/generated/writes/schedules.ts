// Schedule CRUD tools — create, list, update, delete entries in the
// `workflows_schedules` table that the SchedulerReconciler reads on a
// 60s cadence. Each mutation audits and returns the canonical row.
//
// MCP clients see these as `tenant.create_schedule` / `tenant.list_schedules` / etc.

import { z } from "@hono/zod-openapi";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  type ScheduleRow,
  updateSchedule,
} from "../../../../scheduler/repo.ts";
import type { ConversationTool } from "../../index.ts";

// Cron + every-shorthand are documented in the scheduler module. We
// keep the Zod schema permissive (single string, minLength 1) and let
// the repo layer validate via parseCronExpression — it has the richer
// error messaging.
const CronString = z
  .string()
  .min(1)
  .describe(
    'Cron expression (5-field, e.g. "0 9 * * 1-5") or the shorthand "every:<seconds>" (e.g. "every:60").',
  );

function scheduleView(row: ScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    cron: row.cron,
    timezone: row.timezone,
    paused: row.paused,
    input: row.input,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function invalidCronResponse(err: unknown): { ok: false; data: Record<string, unknown> } {
  const e = err as { code?: string; reason?: string; message?: string };
  return {
    ok: false,
    data: {
      error: e.code ?? "invalid_input",
      detail: e.reason ?? e.message ?? "invalid cron expression",
    },
  };
}

const CreateInput = z
  .object({
    workflow_id: z.string().uuid(),
    cron: CronString,
    timezone: z.string().optional(),
    input: z.unknown().optional(),
    paused: z.boolean().optional(),
  })
  .openapi("CreateScheduleToolInput");

export const createScheduleTool: ConversationTool = {
  name: "create_schedule",
  description:
    'Schedule a workflow to run on a cron cadence. Cron is a standard 5-field expression; the shorthand "every:<seconds>" fires at sub-minute intervals for dev loops. Returns the schedule row; the reconciler picks it up within 60 seconds.',
  inputSchema: CreateInput,
  category: "tenant_write",
  requires_persisted_workflow: true,
  async execute(ctx, rawArgs) {
    const args = CreateInput.parse(rawArgs);
    try {
      const row = await createSchedule(ctx.db, {
        tenant_id: ctx.tenant_id,
        workflow_id: args.workflow_id,
        cron: args.cron,
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.input !== undefined ? { input: args.input } : {}),
        ...(args.paused !== undefined ? { paused: args.paused } : {}),
      });
      await ctx.engineClient.audit_write({
        resource_type: "schedule",
        resource_id: row.id,
        action: "schedule.created",
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          cron: row.cron,
          timezone: row.timezone,
          paused: row.paused,
        },
      });
      return { ok: true, data: scheduleView(row) };
    } catch (err) {
      return invalidCronResponse(err);
    }
  },
};

const ListInput = z
  .object({ workflow_id: z.string().uuid().optional() })
  .openapi("ListSchedulesToolInput");

export const listSchedulesTool: ConversationTool = {
  name: "list_schedules",
  description:
    "List all scheduled runs in the tenant, optionally filtered by workflow_id. Returns the current cadence, paused flag, and last update timestamp for each schedule.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = ListInput.parse(rawArgs);
    const rows = await listSchedules(ctx.db, ctx.tenant_id, args.workflow_id ?? undefined);
    return { ok: true, data: { items: rows.map(scheduleView) } };
  },
};

const UpdateInput = z
  .object({
    id: z.string().uuid(),
    cron: CronString.optional(),
    timezone: z.string().optional(),
    paused: z.boolean().optional(),
    input: z.unknown().optional(),
  })
  .openapi("UpdateScheduleToolInput");

export const updateScheduleTool: ConversationTool = {
  name: "update_schedule",
  description:
    "Update a schedule's cron, timezone, paused flag, or input payload. The reconciler picks up the change within 60 seconds.",
  inputSchema: UpdateInput,
  category: "tenant_write",
  requires_persisted_workflow: true,
  async execute(ctx, rawArgs) {
    const args = UpdateInput.parse(rawArgs);
    try {
      const patch: Record<string, unknown> = {};
      if (args.cron !== undefined) patch.cron = args.cron;
      if (args.timezone !== undefined) patch.timezone = args.timezone;
      if (args.paused !== undefined) patch.paused = args.paused;
      if (args.input !== undefined) patch.input = args.input;
      const row = await updateSchedule(ctx.db, ctx.tenant_id, args.id, patch);
      if (!row) return { ok: false, data: { error: "schedule_not_found", id: args.id } };
      await ctx.engineClient.audit_write({
        resource_type: "schedule",
        resource_id: row.id,
        action: "schedule.updated",
        result: "success",
        metadata: { workflow_id: row.workflow_id, patch },
      });
      return { ok: true, data: scheduleView(row) };
    } catch (err) {
      return invalidCronResponse(err);
    }
  },
};

const DeleteInput = z.object({ id: z.string().uuid() }).openapi("DeleteScheduleToolInput");

export const deleteScheduleTool: ConversationTool = {
  name: "delete_schedule",
  description: "Remove a schedule. The reconciler unschedules the pg-boss job within 60 seconds.",
  inputSchema: DeleteInput,
  category: "tenant_write",
  requires_persisted_workflow: true,
  async execute(ctx, rawArgs) {
    const args = DeleteInput.parse(rawArgs);
    // Fetch before delete so the audit entry carries the workflow id.
    const before = await getSchedule(ctx.db, ctx.tenant_id, args.id);
    const ok = await deleteSchedule(ctx.db, ctx.tenant_id, args.id);
    if (!ok) return { ok: false, data: { error: "schedule_not_found", id: args.id } };
    await ctx.engineClient.audit_write({
      resource_type: "schedule",
      resource_id: args.id,
      action: "schedule.deleted",
      result: "success",
      metadata: { workflow_id: before?.workflow_id ?? null },
    });
    return { ok: true, data: { id: args.id, deleted: true } };
  },
};

export const scheduleTools: ConversationTool[] = [
  createScheduleTool,
  listSchedulesTool,
  updateScheduleTool,
  deleteScheduleTool,
];
