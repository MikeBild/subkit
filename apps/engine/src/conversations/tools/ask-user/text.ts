import { z } from "@hono/zod-openapi";
import { isSafeRegex, SAFE_REGEX_REMEDY } from "../../../utils/safe-regex.ts";
import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const inputSchema = z
  .object({
    question: z.string().min(1),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
    validation_regex: z
      .string()
      .refine(isSafeRegex, { message: `regex_unsafe: ${SAFE_REGEX_REMEDY}` })
      .optional(),
    default: z.string().optional(),
  })
  .openapi("AskUserTextInput");

export const askUserTextTool: ConversationTool = {
  name: "ask_user_text",
  description:
    "Ask the user to type a free-form answer. The client renders a text input (multiline optional); the submitted string resumes the loop. Pre-fill a known or likely value via `default` so the user confirms instead of retyping. When the goal lacks several business inputs (for example the destination and the data source of a report), prefer one ask_user_form with a field each before author_workflow; otherwise ask for all of them in this one call and name each one in the question.",
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
