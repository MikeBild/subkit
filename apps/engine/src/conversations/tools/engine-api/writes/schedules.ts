import { z } from "@hono/zod-openapi";
import { inspectScheduleAutomation } from "../../../../scheduler/automation-status.ts";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  type ScheduleRow,
  updateSchedule,
} from "../../../../scheduler/repo.ts";
import type { ConversationTool } from "../../index.ts";

const CronString = z
  .string()
  .min(1)
  .describe(
    'Cron expression (5-field, e.g. "0 9 * * 1-5") or the shorthand "every:<seconds>" (e.g. "every:60").',
  );

const ScheduleInputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

function scheduleView(row: ScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    cron: row.cron,
    timezone: row.timezone,
    execution_mode: row.execution_mode,
    paused: row.paused,
    admission_hold: row.admission_hold,
    readiness_note:
      "Not paused does not mean authorized. A preview or a saved draft never releases a blocked schedule.",
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
    execution_mode: z.enum(["dev", "prod"]).optional(),
    input: ScheduleInputSchema.optional(),
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
  async execute(ctx, args: z.infer<typeof CreateInput>) {
    try {
      const { row, status } = await createSchedule(ctx.db, {
        tenant_id: ctx.tenant_id,
        workflow_id: args.workflow_id,
        cron: args.cron,
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.execution_mode !== undefined ? { execution_mode: args.execution_mode } : {}),
        ...(args.input !== undefined ? { input: args.input } : {}),
        ...(args.paused !== undefined ? { paused: args.paused } : {}),
        creator: ctx.principal ?? null,
      });
      await ctx.engineClient.audit_write({
        resource_type: "schedule",
        resource_id: row.id,
        action: status === "created" ? "schedule.created" : "schedule.updated",
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          cron: row.cron,
          timezone: row.timezone,
          execution_mode: row.execution_mode,
          paused: row.paused,
          kind: status,
          input_changed: args.input !== undefined,
        },
      });
      return { ok: true, data: { ...scheduleView(row), upsert_status: status } };
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
    "Inspect schedules and their current execution permission. Before claiming automatic operation, inspect automation.state: repair_required needs supported fixed effects, approval_required needs the human review dialog. Keeping a cadence is not granting permission. Use review_workflow_automation to show the real recurring-run review in chat; never use ask_user_confirm for recurring authority. This read never runs or authorizes anything.",
  inputSchema: ListInput,
  category: "tenant_read",
  permission: { action: "schedule:read", resourceType: "schedule" },
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const { rows, total } = await listSchedules(
      ctx.db,
      ctx.tenant_id,
      args.workflow_id ?? undefined,
    );
    return {
      ok: true,
      data: {
        items: await Promise.all(
          rows.map(async (row) => ({
            ...scheduleView(row),
            automation: await inspectScheduleAutomation(row, ctx.db),
          })),
        ),
        total,
        returned: rows.length,
        offset: 0,
        has_more: false,
      },
    };
  },
};

const UpdateInput = z
  .object({
    id: z.string().uuid(),
    cron: CronString.optional(),
    timezone: z.string().optional(),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    paused: z.boolean().optional(),
    input: ScheduleInputSchema.optional(),
  })
  .openapi("UpdateScheduleToolInput");

export const updateScheduleTool: ConversationTool = {
  name: "update_schedule",
  description:
    "Update a schedule's cron, timezone, paused flag, or input payload. The reconciler picks up the change within 60 seconds.",
  inputSchema: UpdateInput,
  category: "tenant_write",
  requires_persisted_workflow: true,
  async execute(ctx, args: z.infer<typeof UpdateInput>) {
    try {
      const patch: Record<string, unknown> = {};
      if (args.cron !== undefined) patch.cron = args.cron;
      if (args.timezone !== undefined) patch.timezone = args.timezone;
      if (args.execution_mode !== undefined) patch.execution_mode = args.execution_mode;
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
  async execute(ctx, args: z.infer<typeof DeleteInput>) {
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
