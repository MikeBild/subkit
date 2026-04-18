// propose_connector — draft a Connector from file evidence. Pauses on
// an `ask_user_confirm` elicitation so the operator can review before
// creation.

import { z } from "@hono/zod-openapi";
import { createElicitation } from "../elicitations.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(100).optional(),
    driver: z.enum(["http", "postgres", "s3", "graphql"]),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]).default("none"),
    reason: z.string().min(1).describe("Why this connector should be created"),
  })
  .openapi("ProposeConnectorToolInput");

export const proposeConnectorTool: ConversationTool = {
  name: "propose_connector",
  description:
    "Propose a new Connector based on evidence from analyzed files or conversation context. " +
    "The operator must approve before the Connector is created. " +
    "Use this when you identify an API, database, or service the tenant should integrate with.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    const draft = {
      name: args.name,
      slug: args.slug,
      driver: args.driver,
      base_url: args.base_url,
      dsn: args.dsn,
      auth_type: args.auth_type,
    };

    const summary = `Create connector "${args.name}" (${args.driver})`;
    const input = {
      question: `Create connector "${args.name}"?`,
      kind: "external_write",
      summary: `${summary}: ${args.reason}`,
      diff: draft,
      target: `connector:${args.slug ?? args.name}`,
    };
    const elicitation = await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        tool_call_id: null,
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
        message: `Proposed connector "${args.name}". Awaiting operator approval.`,
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
        target: `connector:${args.slug ?? args.name}`,
      },
    };
  },
};
