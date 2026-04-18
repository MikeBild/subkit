import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("MetricsInput");
const UsageInput = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .openapi("LlmUsageInput");

export const getLlmUsageTool: ConversationTool = {
  name: "get_llm_usage",
  description: "Return this month's total LLM token usage and the N most recent llm_usage rows.",
  inputSchema: UsageInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = UsageInput.parse(rawArgs);
    const [monthly, recent] = await Promise.all([
      ctx.engineClient.metrics.monthlyTokenUsage(),
      ctx.engineClient.metrics.llmUsageRecent(args.limit ?? 20),
    ]);
    return {
      ok: true,
      data: {
        month_bucket: ctx.engineClient.metrics.currentMonthBucket(),
        monthly_total_tokens: monthly,
        recent: recent.map((r) => ({
          flow: r.flow,
          model: r.model,
          prompt_tokens: r.prompt_tokens,
          completion_tokens: r.completion_tokens,
          latency_ms: r.latency_ms,
          result: r.result,
          created_at: r.created_at,
        })),
      },
    };
  },
};

export const getTokenBudgetTool: ConversationTool = {
  name: "get_token_budget",
  description: "Report the tenant's current month token usage against any configured budget.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const used = await ctx.engineClient.metrics.monthlyTokenUsage();
    return {
      ok: true,
      data: { used_tokens: used, month_bucket: ctx.engineClient.metrics.currentMonthBucket() },
    };
  },
};

export const metricsReadTools: ConversationTool[] = [getLlmUsageTool, getTokenBudgetTool];
