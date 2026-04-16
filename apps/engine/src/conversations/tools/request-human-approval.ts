// request_human_approval — write an approval_requests row, pause the
// loop, and emit an `approval_request` frame.

import { z } from "@hono/zod-openapi";
import { createApprovalRequest } from "../approval.ts";
import type { ApprovalKind } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    kind: z.enum(["commit_draft", "external_write", "other"]),
    summary: z.string().min(1),
    diff: z.unknown().optional(),
    /**
     * Free-form target descriptor (e.g. `{url, method}` for an
     * external_write). Surfaced on the SSE frame so the CLI can
     * render a `Target: <url>` line in the approval modal.
     */
    target: z.unknown().optional(),
  })
  .openapi("RequestHumanApprovalToolInput");

export const requestHumanApprovalTool: ConversationTool = {
  name: "request_human_approval",
  description:
    "Pause the conversation and record a sensitive-action approval request for a human operator.",
  inputSchema,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const approval = await createApprovalRequest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        tool_call_id: null,
        kind: args.kind as ApprovalKind,
        summary: args.summary,
        diff: args.diff ?? null,
        actor_id: ctx.actor_id,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: { status: "awaiting", approval_id: approval.id },
      pause: {
        kind: args.kind as ApprovalKind,
        summary: args.summary,
        approval_id: approval.id,
        ...(args.diff !== undefined ? { diff: args.diff } : {}),
        ...(args.target !== undefined ? { target: args.target } : {}),
      },
    };
  },
};
