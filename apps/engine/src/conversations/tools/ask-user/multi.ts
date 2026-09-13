// ask_user_multi — ask the user to pick multiple options from a list.

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
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(1).optional(),
  })
  .openapi("AskUserMultiInput");

export const askUserMultiTool: ConversationTool = {
  name: "ask_user_multi",
  description:
    "Ask the user to pick any subset of options from a list. The client renders a multi-select prompt; the user's chosen values resume the loop.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_multi",
      summary: args.question,
      input: args,
    });
  },
};
