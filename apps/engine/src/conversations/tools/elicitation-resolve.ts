import { decidedByFor } from "../decided-by.ts";
import { resolveElicitationAndReactivate } from "../elicitations.ts";
import { ELICITATION_ALREADY_RESOLVED } from "./error-codes.ts";
import type { ToolContext, ToolResult } from "./index.ts";

export function alreadyResolved(elicitationId: string): ToolResult {
  return {
    ok: false,
    error_code: ELICITATION_ALREADY_RESOLVED,
    message:
      "This elicitation was already answered through another channel; re-read conversation state instead of retrying.",
    data: { status: "already_resolved", elicitation_id: elicitationId },
  };
}

export async function resolveAndError(
  ctx: ToolContext,
  rowId: string,
  p: {
    reason: string;
    errorCode: string;
    message: string;
    transport?: "succeeded" | "failed";
    output?: unknown;
    data?: Record<string, unknown>;
    status?: string;
  },
): Promise<ToolResult> {
  const resolution = await resolveElicitationAndReactivate(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      id: rowId,
      output: p.output ?? null,
      decided_by: decidedByFor(ctx.actor_id, ctx.principal),
      status: "cancelled",
      reason: p.reason,
      ...(p.transport ? { transport: p.transport } : {}),
    },
    ctx.db,
  );
  if (resolution.kind !== "resolved") {
    return alreadyResolved(rowId);
  }
  return {
    ok: false,
    error_code: p.errorCode,
    message: p.message,
    data: {
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.data ?? {}),
    },
  };
}
