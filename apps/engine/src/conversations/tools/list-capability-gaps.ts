import { z } from "@hono/zod-openapi";
import { listCapabilityGaps, toCapabilityGapView } from "../../discovery/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    status: z
      .enum(["proposed", "approved", "rejected", "superseded", "all"])
      .optional()
      .describe(
        "Gap status: proposed = open, approved = accepted, rejected = declined, superseded = resolved. Default proposed; all lists every status.",
      ),
    limit: z.number().int().positive().max(200).default(50),
  })
  .openapi("ListCapabilityGapsToolInput");

export const listCapabilityGapsTool: ConversationTool = {
  name: "list_capability_gaps",
  description:
    "List recorded capability gaps — requests the assistant could not serve because no connector, workflow, or knowledge source exists for them (captured from cannot_help). Returns a deduped backlog ranked by how often each gap recurred, so the operator can prioritise what to build next. Each gap carries its state (open, accepted, declined, resolved) and, once resolved, the resolution note.",
  inputSchema,
  category: "tenant_read" as const,
  permission: { action: "discovery:read", resourceType: "capability_gap" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const gaps = await listCapabilityGaps(
      {
        tenant_id: ctx.tenant_id,
        ...(args.status === "all" ? {} : { status: args.status ?? "proposed" }),
        limit: args.limit,
      },
      ctx.db,
    );
    return { ok: true, data: { gaps: gaps.map(toCapabilityGapView) } };
  },
};
