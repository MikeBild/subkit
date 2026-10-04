import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("StatusSummaryInput");

export const getStatusSummaryTool: ConversationTool = {
  name: "get_engine_status",
  description:
    "Return a one-shot tenant-state summary (counts of workflows, connectors, executions, audit entries, and self-healing fixes open for review).",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const summary = await ctx.engineClient.status.summary();
    return { ok: true, data: summary };
  },
};

export const statusReadTools: ConversationTool[] = [getStatusSummaryTool];
