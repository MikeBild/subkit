// ask_user_confirm — ask the user to approve or reject a specific
// action. Unifies the legacy `request_human_approval` surface. The
// `kind` field lets the client pick the right sub-renderer
// (commit-draft diff, external-write target, generic fallback).
//
// PR 2 migrates commit + external-write callers to emit this tool.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const inputSchema = z
  .object({
    question: z.string().min(1),
    kind: z.enum(["commit_draft", "external_write", "generic"]).default("generic"),
    summary: z.string().optional(),
    /** Structured before/after JSON for commit_draft kinds. */
    diff: z.unknown().optional(),
    /** Free-form target descriptor for external_write kinds. */
    target: z.unknown().optional(),
    /**
     * Hint to the client that the action is dangerous; rendered
     * red-bold and defaults selection to Reject.
     */
    destructive: z.boolean().optional(),
    /** Default choice if the user just presses Enter. */
    default: z.enum(["approve", "reject"]).optional(),
  })
  .openapi("AskUserConfirmInput");

export const askUserConfirmTool: ConversationTool = {
  name: "ask_user_confirm",
  description:
    "Ask the user to approve or reject a specific action. The client renders a styled confirm prompt with an optional feedback reason; the resolved boolean resumes the loop.",
  inputSchema,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_confirm",
      summary: args.summary ?? args.question,
      input: args,
    });
  },
};
