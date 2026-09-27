import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("StatusSummaryInput");

export const getStatusSummaryTool: ConversationTool = {
  name: "get_engine_status",
  description:
    "Return a one-shot tenant-state summary (counts of workflows, connectors, executions, audit entries, and self-healing fixes open for review).",
  inputSchema: EmptyInput,
  // `tenant_read` — reachable by any conversation principal. The operator
  // health digest (failing runs + risk signals) is intentionally NOT folded
  // in here: it exposes cross-workflow operational posture gated on
  // `stats:read`, which this tool does not enforce. Operators read it via
  // GET /v1/operator/health-digest or the gated MCP resource.
  category: "tenant_read",
  async execute(ctx) {
    const summary = await ctx.engineClient.status.summary();
    return { ok: true, data: summary };
  },
};

export const statusReadTools: ConversationTool[] = [getStatusSummaryTool];
