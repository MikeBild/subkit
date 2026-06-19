// propose_schema_migration — surfaces the schema-evolution machinery
// (listShapeHistory + proposeSchemaMigration + applyMigration) as a
// conversation tool so operators can ask "how has this endpoint
// changed?" without writing TypeScript.
//
// Returns the structured plan plus, when a sample is provided, the
// migrated sample so callers can preview the data-level effect of
// applying the plan.

import { z } from "@hono/zod-openapi";
import {
  applyMigration,
  listShapeHistory,
  proposeSchemaMigration,
} from "../../schema-versions/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    connector_id: z.string().uuid(),
    endpoint_key: z.string().min(1),
    /** When set, applyMigration runs against the sample and the result
     *  is returned alongside the plan so the operator sees the
     *  data-level effect of accepting it. */
    sample: z.unknown().optional(),
    /** Cap the chronological history attached to the response. */
    history_limit: z.number().int().positive().max(200).optional(),
  })
  .openapi("ProposeSchemaMigrationToolInput");

export const proposeSchemaMigrationTool: ConversationTool = {
  name: "propose_schema_migration",
  description:
    "Inspect the recorded shape history for a connector endpoint and propose a structured migration plan (renames, adds, removes, widens) between the first-recorded and latest shape. Returns the plan, a fully_safe flag, and — when a sample is supplied — the sample after applying the plan.",
  use_case:
    "Use when an operator asks why an endpoint started returning a different shape, or to preview the data-level effect of accepting a recent rename. The plan is advisory; nothing is persisted.",
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const plan = await proposeSchemaMigration(
      {
        tenant_id: ctx.tenant_id,
        connector_id: args.connector_id,
        endpoint_key: args.endpoint_key,
      },
      ctx.db,
    );
    if (!plan) {
      return {
        ok: true,
        data: {
          status: "no_history",
          message: `no recorded shapes for endpoint '${args.endpoint_key}' on this connector`,
          plan: null,
        },
      };
    }
    const history = await listShapeHistory(
      {
        tenant_id: ctx.tenant_id,
        connector_id: args.connector_id,
        endpoint_key: args.endpoint_key,
        limit: args.history_limit ?? 10,
      },
      ctx.db,
    );
    const oldest = history[history.length - 1];
    const newest = history[0];
    const data: Record<string, unknown> = {
      status: plan.steps.length === 0 ? "shape_stable" : "migration_proposed",
      plan,
      history_count: history.length,
      first_seen_at: oldest?.seen_at ?? null,
      latest_seen_at: newest?.seen_at ?? null,
    };
    if (args.sample !== undefined) {
      data.migrated_sample = applyMigration(plan, args.sample);
    }
    return { ok: true, data };
  },
};
