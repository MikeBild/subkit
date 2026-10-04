import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const inputSchema = z
  .object({
    question: z.string().min(1),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    validation_regex: z.string().optional(),
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
