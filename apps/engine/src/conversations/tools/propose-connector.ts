// propose_connector — draft a Connector from file evidence.
// Triggers request_human_approval so the operator can review before creation.

import { z } from "@hono/zod-openapi";
import { createApprovalRequest } from "../approval.ts";
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

    const approval = await createApprovalRequest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        tool_call_id: null,
        kind: "external_write",
        summary: `Create connector "${args.name}" (${args.driver})`,
        diff: draft,
        actor_id: ctx.actor_id,
      },
      ctx.db,
    );

    return {
      ok: true,
      data: {
        message: `Proposed connector "${args.name}". Awaiting operator approval.`,
        draft,
        approval_id: approval.id,
      },
      pause: {
        kind: "external_write",
        summary: `Create connector "${args.name}" (${args.driver}): ${args.reason}`,
        approval_id: approval.id,
        diff: draft,
        target: `connector:${args.slug ?? args.name}`,
      },
    };
  },
};
