import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { getOperationalOverview } from "../../../operator/operational-overview.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const Drilldown = z.object({ path: z.string(), label_id: z.string() });
const Metric = z.object({
  id: z.string(),
  label: z.string(),
  definition: z.string(),
  relevance: z.string(),
  kind: z.enum(["count", "ratio", "duration", "score", "currency", "state"]),
  value: z.number().nullable(),
  value_state: z.enum(["observed", "zero", "missing", "stale", "forbidden"]),
  unit: z.enum(["count", "ratio", "seconds", "bytes", "eur", "state"]),
  severity: z.enum(["critical", "urgent", "healthy", "information", "unknown"]),
  required: z.boolean(),
  source_updated_at: z.string().nullable(),
  expected_interval_seconds: z.number().int().nullable(),
  stale_after_seconds: z.number().int().nullable(),
  drilldown: Drilldown,
  prometheus: z.object({ name: z.string(), type: z.enum(["gauge", "counter"]) }),
});
const Health = Metric.extend({
  state: z.enum(["healthy", "limited", "critical", "unknown"]),
  components: z.array(
    z.object({
      id: z.string(),
      raw_value: z.number().nullable(),
      unit: z.string(),
      normalized_score: z.number().nullable(),
      weight: z.number(),
      contribution: z.number().nullable(),
      freshness: z.enum(["fresh", "stale", "missing", "forbidden"]),
      required: z.boolean(),
    }),
  ),
});
const Freshness = Metric.extend({
  state: z.enum(["fresh", "stale", "missing", "forbidden"]),
  sources: z.array(
    z.object({
      id: z.string(),
      updated_at: z.string().nullable(),
      expected_interval_seconds: z.number().int(),
      stale_after_seconds: z.number().int(),
      state: z.enum(["fresh", "stale", "missing", "forbidden"]),
    }),
  ),
});
const Response = z
  .object({
    schema_version: z.literal("operational-overview.v1"),
    contract_version: z.literal("2.0"),
    product: z.literal("subkit"),
    generated_at: z.string(),
    recommended_refresh_seconds: z.number().int().min(10).max(300),
    snapshot_state: z.enum(["ready", "partial", "forbidden", "contract-mismatch"]),
    core: z.object({
      blocked: Metric,
      overdue: Metric,
      other_decisions: Metric,
      health: Health,
      data_freshness: Freshness,
    }),
    sections: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        visualization: z.enum([
          "kpi",
          "sparkline",
          "time-series",
          "progress",
          "segmented-distribution",
        ]),
        metrics: z.array(Metric),
        drilldown: Drilldown,
      }),
    ),
    audit: z.object({
      path: z.literal("/cockpit/audit"),
      contract_version: z.literal("2.0"),
      snapshot_generated_at: z.string(),
    }),
  })
  .openapi("OperationalOverviewV1");

const route = createRoute({
  method: "get",
  path: "/v1/operational-overview",
  tags: ["operator"],
  summary: "Operational overview",
  description: "Role-aware dashboard snapshot shared by Cockpit, MCP and Prometheus.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "operational-overview.v1 snapshot",
      content: { "application/json": { schema: Response } },
    },
  },
});

export function registerOperationalOverviewRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/operational-overview", requirePermission("stats:read"));
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    return c.json(await getOperationalOverview(c.get("db"), principal.tenant_id), 200);
  });
}
