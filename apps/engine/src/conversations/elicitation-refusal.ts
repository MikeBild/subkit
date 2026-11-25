import type { CONVERSATION_ABANDONED } from "./core/conversation-status.ts";
import type { ToolResult } from "./tools/index.ts";

export interface ElicitationRefusalOutput {
  ok: false;
  status: "refused";
  reason: typeof CONVERSATION_ABANDONED;
  note: string;
}

export function elicitationRefusalOutput(
  reason: typeof CONVERSATION_ABANDONED,
): ElicitationRefusalOutput {
  return {
    ok: false,
    status: "refused",
    reason,
    note: "No question was asked. This conversation was abandoned and accepts no new question. Stop here and do not ask again.",
  };
}

export function elicitationRefusalResult(reason: typeof CONVERSATION_ABANDONED): ToolResult {
  const output = elicitationRefusalOutput(reason);
  return { ok: false, data: output, error_code: reason, message: output.note };
}
