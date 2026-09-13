// Execution read tools.

import { z } from "@hono/zod-openapi";

import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    workflow_id: z.string().uuid().optional(),
  })
  .openapi("ListExecutionsToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetExecutionToolInput");

export const listExecutionsTool: ConversationTool = {
  name: "list_executions",
  description:
    "List recent executions for the tenant (newest first, paged — executions are an unbounded history). When the user names a workflow, first resolve it with get_workflow/find_workflow and pass workflow_id; never treat the tenant-wide latest execution as evidence for a named workflow. `total` is the exact count under the given filters; page with limit/offset while `has_more` is true.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const offset = args.offset ?? 0;
    const { rows, total } = await ctx.engineClient.executions.list({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
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
        offset,
        has_more: offset + rows.length < total,
      },
    };
  },
};

export const getExecutionTool: ConversationTool = {
  name: "get_execution",
  description: "Fetch one execution by id (full row including status and timestamps).",
  inputSchema: GetInput,
  category: "tenant_read",
  permission: { action: "execution:read", resourceType: "execution", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const e = await ctx.engineClient.executions.get(args.id);
    if (!e) return { ok: false, data: { error: "execution_not_found" } };
    return { ok: true, data: { execution: e } };
  },
};

export const executionReadTools: ConversationTool[] = [listExecutionsTool, getExecutionTool];
