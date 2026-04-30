// propose_skill — draft a Skill from file evidence or detected patterns.
// Pauses on an `ask_user_confirm` elicitation so the operator can review
// before creation.

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
        actor_id: ctx.actor_id,
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
