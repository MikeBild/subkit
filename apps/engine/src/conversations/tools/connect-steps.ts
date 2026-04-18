// connect_steps — declare an ordering relationship between two steps.
//
// Execution order is implicit in the step array, so the current
// implementation records the edge on the draft metadata. Step
// reordering is future work; the tool still passes validation back
// so the loop can react to missing step ids.

import { z } from "@hono/zod-openapi";
import type { DraftDocument } from "../types.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .openapi("ConnectStepsToolInput");

export const connectStepsTool: ConversationTool = {
  name: "connect_steps",
  description: "Declare an ordering edge between two steps in the draft.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = structuredClone(ctx.getDraft()) as DraftDocument;
    const withEdges = draft as DraftDocument & {
      edges?: Array<{ from: string; to: string }>;
    };
    const fromIdx = draft.steps.findIndex((s) => s.id === args.from);
    const toIdx = draft.steps.findIndex((s) => s.id === args.to);
    if (fromIdx < 0) {
      return { ok: false, data: { error: `unknown step id: ${args.from}` } };
    }
    if (toIdx < 0) {
      return { ok: false, data: { error: `unknown step id: ${args.to}` } };
    }
    const edges = withEdges.edges ?? [];
    edges.push({ from: args.from, to: args.to });
    withEdges.edges = edges;
    // Reorder so `to` follows `from` when it doesn't already — this
    // is a gentle hint so the engine runs them in the requested order.
    if (toIdx < fromIdx) {
      const [moved] = draft.steps.splice(toIdx, 1);
      if (moved) draft.steps.splice(fromIdx, 0, moved);
    }
    await ctx.setDraft(draft);
    return { ok: true, data: { from: args.from, to: args.to, edges: edges.length } };
  },
};
