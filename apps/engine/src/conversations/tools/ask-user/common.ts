// Shared helper for the `ask_user_*` tool family. Each tool is a thin
// wrapper around this function — it insert-persists an elicitation row
// and returns a `pause` payload the loop surfaces as an
// `awaiting_input`-style completion.
//
// The loop treats any `ToolResult.pause` the same way it treats the
// existing approval pause, so the pause contract stays compatible.

import { createElicitation } from "../../elicitations.ts";
import type { ToolContext, ToolResult } from "../index.ts";

type AskUserToolName = NonNullable<ToolResult["pause"]>["tool_name"];

export async function pauseForUserInput(
  ctx: ToolContext,
  p: { tool_name: AskUserToolName; summary: string; input: unknown },
): Promise<ToolResult> {
  const row = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: ctx.tool_call_id ?? null,
      tool_name: p.tool_name,
      summary: p.summary,
      input: p.input,
      actor_id: ctx.actor_id,
    },
    ctx.db,
  );
  return {
    ok: true,
    data: { status: "awaiting_input", elicitation_id: row.id },
    pause: {
      tool_name: p.tool_name,
      summary: p.summary,
      elicitation_id: row.id,
      input: p.input,
    },
  };
}
