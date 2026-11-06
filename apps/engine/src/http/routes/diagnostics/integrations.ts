import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getDb } from "../../../db/client.ts";
import { readIntegrationsHealth } from "../../../operator/integrations-health.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const ConnectorHealthEntry = z
  .object({
    id: z.string(),
    slug: z.string(),
    environment: z.string(),
    effective_health: z.enum(["ok", "degraded", "needs_update", "needs_reauth"]),
    health_reason: z.string().nullable(),
    health_error_code: z.string().nullable(),
    sunset_at: z.string().nullable(),
    successor_uri: z.string().nullable(),
    needs_reauth: z.boolean(),
    circuit_state: z.string(),
  })
  .openapi("DiagnosticsConnectorHealth");

const WorkflowHealthEntry = z
  .object({
    id: z.string(),
    slug: z.string(),
    health_state: z.string(),
    health_reason: z.string().nullable(),
  })
  .openapi("DiagnosticsWorkflowHealth");

const IntegrationsResponse = z
  .object({
    connectors: z.array(ConnectorHealthEntry),
    workflows_attention: z.array(WorkflowHealthEntry),
    summary: z.object({
      connectors_total: z.number().int().nonnegative(),
      connectors_attention: z.number().int().nonnegative(),
      workflows_attention: z.number().int().nonnegative(),
    }),
  })
  .openapi("DiagnosticsIntegrationsResponse");

const route = createRoute({
  method: "get",
  path: "/v1/diagnostics/integrations",
  tags: ["diagnostics"],
  summary: "Connector/workflow health rollup (reauth, removed/deprecated endpoints, degraded)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: IntegrationsResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerIntegrationsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db") ?? getDb();

    const health = await readIntegrationsHealth(db, principal);
    const connectorEntries = health.connectors;
    const workflowRows = health.workflows;
    const connectorsAttention = health.connectors_attention;

    return c.json(
      {
        connectors: connectorEntries,
        workflows_attention: workflowRows.map((w) => ({
          id: w.id,
          slug: w.slug,
          health_state: w.health_state,
          health_reason: w.health_reason ?? null,
        })),
        summary: {
          connectors_total: connectorEntries.length,
          connectors_attention: connectorsAttention,
          workflows_attention: workflowRows.length,
        },
      },
      200,
    );
  });
}
