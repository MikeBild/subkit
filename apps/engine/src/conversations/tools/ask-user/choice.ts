// ask_user_choice — ask the user to pick one option from a list.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const inputSchema = z
  .object({
    question: z.string().min(1),
    options: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
        }),
      )
      .min(2),
    /** Optional pre-selected option value — the client renders the
     *  cursor on it so the user confirms with one keypress. Must equal
     *  one of the declared option values. */
    default: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.default !== undefined && !input.options.some((o) => o.value === input.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "default must equal one of the declared option values",
        path: ["default"],
      });
    }
  })
  .openapi("AskUserChoiceInput");

export const askUserChoiceTool: ConversationTool = {
  name: "ask_user_choice",
  description:
    "Ask the user to pick exactly one option from a list of choices (2-4 options; put the recommended option first and give each a one-line `description`). The client renders a Select prompt; the user's selected value resumes the loop. Pre-select the recommended value via `default`.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_choice",
      summary: args.question,
      input: args,
    });
  },
};
