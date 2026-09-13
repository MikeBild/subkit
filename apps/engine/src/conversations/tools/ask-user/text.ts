// ask_user_text — ask the user for a free-form text answer.

import { z } from "@hono/zod-openapi";

import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const inputSchema = z
  .object({
    question: z.string().min(1),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    /** Optional regex validated client-side before submit AND re-validated
     *  server-side on respond (see ask-user/validate-answer.ts). */
    validation_regex: z.string().optional(),
    /** Optional pre-filled value rendered as the initial buffer — the
     *  user confirms or edits instead of retyping. */
    default: z.string().optional(),
  })
  .openapi("AskUserTextInput");

export const askUserTextTool: ConversationTool = {
  name: "ask_user_text",
  description:
    "Ask the user to type a free-form answer. The client renders a text input (multiline optional); the submitted string resumes the loop. Pre-fill a known or likely value via `default` so the user confirms instead of retyping.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_text",
      summary: args.question,
      input: args,
    });
  },
};
