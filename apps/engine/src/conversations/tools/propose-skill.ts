import { z } from "@hono/zod-openapi";
import { createElicitation } from "../elicitations.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    scope: z.enum(["global", "connector", "workflow"]).default("global"),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(5000),
    examples: z.array(z.string()).max(10).optional(),
    best_practices: z.array(z.string()).max(5).optional(),
    pitfalls: z.array(z.string()).max(5).optional(),
    reason: z.string().min(1).describe("Why this skill should be created"),
  })
  .openapi("ProposeSkillToolInput");

export const proposeSkillTool: ConversationTool = {
  name: "propose_skill",
  description:
    "Propose a new Skill based on evidence from analyzed files, compliance docs, or detected patterns. " +
    "The operator must approve before the Skill is created (as a draft). " +
    "Use this when you identify operational rules, best practices, or conventions.",
  inputSchema,
  category: "draft_write" as const,
  strict: true,
  example_input: {
    scope: "global",
    title: "Always idempotency-key POST requests against the payments provider",
    body: "When calling payments-provider POST endpoints, include an Idempotency-Key header derived from the workflow run id so retries don't double-charge.",
    examples: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder grammar surfaced to the LLM as few-shot text.
      'curl -X POST https://payments.example.test/v1/charges -H "Idempotency-Key: ${run_id}"',
    ],
    best_practices: [
      "Use a stable per-run id, not a fresh uuid per attempt.",
      "Combine the run id with the step id for granular idempotency.",
    ],
    pitfalls: ["Don't reuse keys across runs — Stripe will return the prior response."],
    reason: "Observed two duplicate-charge incidents in support tickets.",
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    const draft = {
      scope: args.scope,
      title: args.title,
      body: args.body,
      examples: args.examples ?? [],
      best_practices: args.best_practices ?? [],
      pitfalls: args.pitfalls ?? [],
    };

    const summary = `Create ${args.scope} skill "${args.title}"`;
    const input = {
      question: `Create ${args.scope} skill "${args.title}"?`,
      kind: "external_write",
      summary: `${summary}: ${args.reason}`,
      diff: draft,
      target: `skill:${args.title}`,
    };
    const elicitation = await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        tool_call_id: ctx.tool_call_id ?? null,
        ...(ctx.assistant_message_id ? { parent_message_id: ctx.assistant_message_id } : {}),
        tool_name: "ask_user_confirm",
        summary,
        input,
        actor_id: ctx.engineClient.context.actor_id,
        ...(ctx.engineClient.context.actor_type
          ? { actor_type: ctx.engineClient.context.actor_type }
          : {}),
      },
      ctx.db,
    );

    return {
      ok: true,
      data: {
        message: `Proposed skill "${args.title}". Awaiting operator approval.`,
        draft,
        elicitation_id: elicitation.id,
      },
      pause: {
        tool_name: "ask_user_confirm",
        kind: "external_write",
        summary,
        elicitation_id: elicitation.id,
        input,
        diff: draft,
        target: `skill:${args.title}`,
      },
    };
  },
};
