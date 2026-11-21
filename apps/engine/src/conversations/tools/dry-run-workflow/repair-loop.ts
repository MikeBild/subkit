import { logger } from "../../../logging/index.ts";
import { recordAuthoringGateBlock } from "../../../observability/instrumentation.ts";
import { repairLoopMessage, type ToolCallRow, trippedRepairCodes } from "../../core/dry-run.ts";
import { buildGateError } from "../authoring-contract.ts";
import type { ToolContext, ToolResult } from "../index.ts";

export type RecentToolCalls = (ctx: ToolContext) => Promise<ToolCallRow[]>;

export async function repairLoopGate(
  ctx: ToolContext,
  recentToolCalls: RecentToolCalls,
): Promise<ToolResult | null> {
  try {
    const trippedCodes = trippedRepairCodes(await recentToolCalls(ctx));
    if (trippedCodes.length === 0) return null;
    logger.warn({
      module: "conversation_tool",
      action: "dry_run_workflow.repair_loop_detected",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tripped_codes: trippedCodes,
    });
    recordAuthoringGateBlock({ code: "repair_loop_detected", tool: "dry_run_workflow" });
    return {
      ok: false,
      data: buildGateError(ctx.getDraft(), {
        error_code: "repair_loop_detected",
        message: repairLoopMessage(trippedCodes),
        recommended_mode: "workflow",
        next_best_actions: [
          "ask_user_text",
          "load_skill",
          "search_knowledge",
          "inspect_workflow_draft",
          "edit_workflow_patch",
        ],
        extra: { tripped_codes: trippedCodes },
      }),
    };
  } catch (err) {
    logger.warn({
      module: "conversation_tool",
      action: "dry_run_workflow.repair_loop_query_failed",
      msg: "repair-loop history query failed; circuit-breaker check skipped this turn",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
