import { z } from "@hono/zod-openapi";
import { executionStatusEnum } from "../../../db/schema/index.ts";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(128).optional(),
    workflow_id: z.string().uuid().optional(),
    status: z.enum(executionStatusEnum.enumValues).optional(),
    request_source: z.string().min(1).optional(),
    started_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started at or after this instant (ISO 8601)."),
    started_to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started before this instant (ISO 8601, exclusive)."),
  })
  .openapi("ListExecutionsToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetExecutionToolInput");

export const listExecutionsTool: ConversationTool = {
  name: "list_executions",
  description:
    "List recent executions for the tenant (newest first, paged — executions are an unbounded history). When the user names a workflow, first resolve it with get_workflow/find_workflow and pass workflow_id; never treat the tenant-wide latest execution as evidence for a named workflow. started_from/started_to narrow to a window on the start time (the window `get_operating_figures` counts over), status to one outcome. `total` is the exact count under the given filters; while `has_more` is true, pass `next_cursor` back verbatim as `cursor` for the next page.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const { rows, total, next_cursor } = await ctx.engineClient.executions.list({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.request_source !== undefined ? { request_source: args.request_source } : {}),
      ...(args.started_from !== undefined ? { started_from: new Date(args.started_from) } : {}),
      ...(args.started_to !== undefined ? { started_to: new Date(args.started_to) } : {}),
    });
    return {
      ok: true,
      data: {
        items: rows.map((e) => ({
          id: e.id,
          workflow_id: e.workflow_id,
          status: e.status,
          started_at: e.started_at,
          finished_at: e.finished_at,
        })),
        total,
        returned: rows.length,
        next_cursor,
        has_more: next_cursor !== null,
      },
    };
  },
};

export const getExecutionTool: ConversationTool = {
  name: "get_execution",
  description:
    "Fetch one execution by id (full row including status and timestamps) plus its structured `outcome`: kind (succeeded / failed / held = writes held in a preview, nothing written / partial = a tolerated step failure / running), the failed step, its cause class and error code, step counts, and the output-contract verdict.",
  inputSchema: GetInput,
  category: "tenant_read",
  permission: { action: "execution:read", resourceType: "execution", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const e = await ctx.engineClient.executions.get(args.id);
    if (!e) return { ok: false, data: { error: "execution_not_found" } };
    return {
      ok: true,
      data: { execution: e, outcome: await ctx.engineClient.executions.outcome(e) },
    };
  },
};

export const executionReadTools: ConversationTool[] = [listExecutionsTool, getExecutionTool];
