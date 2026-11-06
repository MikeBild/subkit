import { and, eq, isNull, ne } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  DiagnosticsIntegrationsReadMetadataSchema,
} from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { effectiveConnectorHealth } from "../connectors/index.ts";
import type { Db } from "../db/client.ts";
import { connectors, workflows } from "../db/schema/index.ts";

export type IntegrationsActor = Pick<ResolvedPrincipal, "tenant_id" | "kind" | "id">;

export async function readIntegrationsHealth(db: Db, actor: IntegrationsActor) {
  const tenantId = actor.tenant_id;
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
    .where(and(eq(connectors.tenant_id, tenantId), isNull(connectors.deleted_at)));

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
        eq(workflows.tenant_id, tenantId),
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
      tenant_id: tenantId,
      actor_type: actor.kind,
      actor_id: actor.id,
      action: AuditAction.DIAGNOSTICS_INTEGRATIONS_READ,
      resource_type: "engine",
      resource_id: null,
      result: "success",
      metadata,
    },
    db,
  );

  return {
    connectors: connectorEntries,
    workflows: workflowRows,
    connectors_attention: connectorsAttention,
  };
}
