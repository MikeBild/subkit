// Connector/workflow health rollup diagnostics endpoint.
//
//   GET /v1/diagnostics/integrations
//
// The "find out early" surface: which connectors are broken (needs_reauth),
// pointing at removed/deprecated endpoints (needs_update, with the vendor's
// announced successor URI and sunset date), or degraded — plus the workflows
// flagged needs_attention because a dependency went bad. `sk doctor` renders
// this so an operator learns about a dead integration from a health check,
// not from an unattended run returning "0 results" (the production failure
// mode this subsystem exists to kill).
//
// Mirrors the layering of `diagnostics/version.ts`: path-scoped RBAC in
// `diagnostics/index.ts`, an audited read, Zod response components.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, ne } from "drizzle-orm";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  AuditAction,
  auditAwait,
  DiagnosticsIntegrationsReadMetadataSchema,
} from "../../../audit/index.ts";
import { effectiveConnectorHealth } from "../../../connectors/index.ts";
import { getDb } from "../../../db/client.ts";
import { connectors, workflows } from "../../../db/schema/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const ConnectorHealthEntry = z
  .object({
    id: z.string(),
    slug: z.string(),
    environment: z.string(),
    /** Reconciled verdict across health_state / needs_reauth / circuit_state
     *  (precedence: needs_reauth > needs_update > degraded > ok) — the ONE
     *  value displays should branch on. */
    effective_health: z.enum(["ok", "degraded", "needs_update", "needs_reauth"]),
    health_reason: z.string().nullable(),
    health_error_code: z.string().nullable(),
    /** Vendor-announced removal date (Sunset header), when known. */
    sunset_at: z.string().nullable(),
    /** Vendor-announced replacement endpoint/docs URI, when known. */
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
    /** Only workflows whose health_state is not "ok" — the attention list. */
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

    const connectorRows = await db
      .select({
        id: connectors.id,
        slug: connectors.slug,
        environment: connectors.environment,
        health_state: connectors.health_state,
        health_reason: connectors.health_reason,
        health_error_code: connectors.health_error_code,
        sunset_at: connectors.sunset_at,
        successor_uri: connectors.successor_uri,
        needs_reauth: connectors.needs_reauth,
        circuit_state: connectors.circuit_state,
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, principal.tenant_id), isNull(connectors.deleted_at)));

    const workflowRows = await db
      .select({
        id: workflows.id,
        slug: workflows.slug,
        health_state: workflows.health_state,
        health_reason: workflows.health_reason,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, principal.tenant_id),
          isNull(workflows.deleted_at),
          ne(workflows.health_state, "ok"),
        ),
      );

    const connectorEntries = connectorRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      environment: row.environment,
      effective_health: effectiveConnectorHealth(row),
      health_reason: row.health_reason ?? null,
      health_error_code: row.health_error_code ?? null,
      sunset_at: row.sunset_at?.toISOString() ?? null,
      successor_uri: row.successor_uri ?? null,
      needs_reauth: row.needs_reauth,
      circuit_state: row.circuit_state,
    }));
    const connectorsAttention = connectorEntries.filter((e) => e.effective_health !== "ok").length;

    const metadata = DiagnosticsIntegrationsReadMetadataSchema.parse({
      connectors_total: connectorEntries.length,
      connectors_attention: connectorsAttention,
      workflows_attention: workflowRows.length,
    });
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.DIAGNOSTICS_INTEGRATIONS_READ,
        resource_type: "engine",
        resource_id: null,
        result: "success",
        metadata,
      },
      db,
    );

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
