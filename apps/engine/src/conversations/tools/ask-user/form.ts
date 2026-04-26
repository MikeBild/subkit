// ask_user_form — ask the user to fill in a structured form.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../index.ts";
import { commitIntentSchema } from "./commit-intent.ts";
import { pauseForUserInput } from "./common.ts";

const fieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  /**
   * `password` renders as a masked input and is NEVER surfaced on
   * downstream tool-result payloads or in the transcript — it belongs
   * to the credential-collection flow. `text` | `number` | `boolean` |
   * `select` render as plain inputs.
   */
  type: z.enum(["text", "number", "boolean", "select", "password"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  /** When true, the client must mask the field value on keystroke echo. */
  sensitive: z.boolean().optional(),
});

const inputSchema = z
  .object({
    question: z.string().min(1),
    fields: z.array(fieldSchema).min(1),
    /**
     * Optional commit intent. When set, the harness applies the
     * intended write atomically once the operator submits — the LLM
     * does NOT need to call save_connector_draft/commit_draft
     * afterwards. See `./commit-intent.ts` for the schema.
     */
    commit_intent: commitIntentSchema.optional(),
  })
  .openapi("AskUserFormInput");

export const askUserFormTool: ConversationTool = {
  name: "ask_user_form",
  description:
    'Ask the user to fill in a small form of typed fields. The client renders a stacked input; the submitted {name:value} map resumes the loop. If you pass `commit_intent`, the harness applies the intended write atomically when the operator submits — the form value (e.g. credential) flows directly into the commit. You DO NOT need to call save_connector_draft afterward; the next turn will already see a synthetic tool result describing the persistence with source="harness_auto_persist".',
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
