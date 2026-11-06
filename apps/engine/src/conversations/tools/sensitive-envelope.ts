import type { ToolResult } from "./index.ts";

export const SENSITIVE_EXECUTION_UNSUPPORTED = "sensitive_execution_unsupported";

export const SENSITIVE_LIVE_VERIFICATION_HANDOFF =
  "Live verification of a sensitive workflow happens in the Cockpit by the signed-in person; chat checks only its structure.";

export const SCHEMA_ONLY_NOTE = "Structure checked, content not checked.";

const SENSITIVE_UNSUPPORTED_NEXT_ACTIONS = ["inspect_workflow_draft", "validate_draft"];

export function sensitiveExecutionUnsupported(message?: string): ToolResult {
  const text = message
    ? `${message} ${SENSITIVE_LIVE_VERIFICATION_HANDOFF}`
    : `Sensitive execution data never enters chat. ${SENSITIVE_LIVE_VERIFICATION_HANDOFF}`;
  return {
    ok: false,
    error_code: SENSITIVE_EXECUTION_UNSUPPORTED,
    message: text,
    next_best_actions: [...SENSITIVE_UNSUPPORTED_NEXT_ACTIONS],
    data: {
      error_code: SENSITIVE_EXECUTION_UNSUPPORTED,
      content_withheld: true,
      message: text,
      next_best_actions: [...SENSITIVE_UNSUPPORTED_NEXT_ACTIONS],
      handoff: SENSITIVE_LIVE_VERIFICATION_HANDOFF,
    },
  };
}
