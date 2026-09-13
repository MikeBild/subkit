// list_capability_gaps — surface recorded coverage gaps (cannot_help
// abstentions) as a deduped, demand-ranked backlog for the operator.
//
// A capability gap is the inverse of an answer: a request the assistant
// could not serve because no connector / workflow / knowledge source
// exists for it. Each cannot_help call records (or increments) one;
// this tool lists them, most-requested first, so the operator can decide
// what to build next.

import { z } from "@hono/zod-openapi";

import { listCapabilityGaps } from "../../discovery/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
    limit: z.number().int().positive().max(200).default(50),
  })
  .openapi("ListCapabilityGapsToolInput");

export const listCapabilityGapsTool: ConversationTool = {
  name: "list_capability_gaps",
  description:
    "List recorded capability gaps — requests the assistant could not serve because no connector, workflow, or knowledge source exists for them (captured from cannot_help). Returns a deduped backlog ranked by how often each gap recurred, so the operator can prioritise what to build next.",
  inputSchema,
  category: "tenant_read" as const,
  // Operator backlog, not enduser self-description: the read-only chat
  // `enduser` role deliberately lacks `discovery:read` (rbac/seed.ts).
  permission: { action: "discovery:read", resourceType: "capability_gap" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const gaps = await listCapabilityGaps(
      {
        tenant_id: ctx.tenant_id,
        status: args.status ?? "proposed",
        limit: args.limit,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        gaps: gaps.map((g) => {
          const d = g.draft as {
            requested?: string;
            missing_capability?: string | null;
            suggested_kind?: string;
            occurrences?: number;
          };
          return {
            id: g.id,
            status: g.status,
            missing_capability: d.missing_capability ?? null,
            requested: d.requested ?? g.title,
            suggested_kind: d.suggested_kind ?? "unknown",
            occurrences: d.occurrences ?? 1,
            created_at: g.created_at,
            updated_at: g.updated_at,
          };
        }),
      },
    };
  },
};
