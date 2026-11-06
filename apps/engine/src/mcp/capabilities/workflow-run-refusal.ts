import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunRefusal } from "../../execution/use-cases/run-workflow.ts";

function nextActions(refusal: RunRefusal): string[] {
  if (refusal.refusal === "not_found") return ["find_workflow", "list_workflows"];
  if (refusal.refusal === "input" || refusal.refusal === "bad_request") return ["get_workflow"];
  if (refusal.execution_id) return ["get_execution"];
  if (refusal.refusal === "budget") return [];
  return ["inspect_workflow"];
}

export function workflowRunRefusalResult(refusal: RunRefusal, slug: string): CallToolResult {
  const details =
    refusal.details && typeof refusal.details === "object" && !Array.isArray(refusal.details)
      ? { details: refusal.details }
      : {};
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "cannot_help",
          error_code: refusal.code,
          workflow: slug,
          message: `${refusal.message} Nothing ran. Do NOT retry ${slug} unchanged; fix the cause first.`,
          ...(refusal.execution_id ? { execution_id: refusal.execution_id } : {}),
          ...details,
          next_best_actions: nextActions(refusal),
        }),
      },
    ],
  };
}

export function workflowRunReplayResult(
  slug: string,
  replayed: { execution_id: string; status: string },
): CallToolResult {
  return {
    isError: false,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: replayed.status,
          execution_id: replayed.execution_id,
          idempotent_replay: true,
          message: `Nothing new was started: execution ${replayed.execution_id} of ${slug} already used this idempotency key (status: ${replayed.status}). Poll get_execution with this execution_id for its result.`,
          poll_with: "get_execution",
        }),
      },
    ],
    _meta: { subkit: { execution: { id: replayed.execution_id, status: replayed.status } } },
  };
}
