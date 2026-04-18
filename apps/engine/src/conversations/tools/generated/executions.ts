// Execution read tools.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    workflow_id: z.string().uuid().optional(),
  })
  .openapi("ListExecutionsToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetExecutionToolInput");

export const listExecutionsTool: ConversationTool = {
  name: "list_executions",
  description: "List recent executions for the tenant. Optional filter by workflow_id.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = ListInput.parse(rawArgs);
    const rows = await ctx.engineClient.executions.list({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
    });
    return {
      ok: true,
      data: {
        executions: rows.map((e) => ({
          id: e.id,
          workflow_id: e.workflow_id,
          status: e.status,
          started_at: e.started_at,
          finished_at: e.finished_at,
        })),
      },
    };
  },
};

export const getExecutionTool: ConversationTool = {
  name: "get_execution",
  description: "Fetch one execution by id (full row including status and timestamps).",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const e = await ctx.engineClient.executions.get(args.id);
    if (!e) return { ok: false, data: { error: "execution_not_found" } };
    return { ok: true, data: { execution: e } };
  },
};

export const executionReadTools: ConversationTool[] = [listExecutionsTool, getExecutionTool];
