// ask_user_form — ask the user to fill in a structured form.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../index.ts";
import { pauseForUserInput } from "./common.ts";

const fieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "select"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});

const inputSchema = z
  .object({
    question: z.string().min(1),
    fields: z.array(fieldSchema).min(1),
  })
  .openapi("AskUserFormInput");

export const askUserFormTool: ConversationTool = {
  name: "ask_user_form",
  description:
    "Ask the user to fill in a small form of typed fields. The client renders a stacked input; the submitted {name:value} map resumes the loop.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_form",
      summary: args.question,
      input: args,
    });
  },
};
