import { and, eq } from "drizzle-orm";
import { recordConnectorMcpManifestDrift } from "../../audit/recorders/index.ts";
import type { AuditActorType } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { connectorMcpSessions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { MANIFEST_HASH_VERSION, manifestHashVersion } from "./manifest.ts";

interface ReconcileManifestHashInput {
  db: Executor;
  tenant_id: string;
  connector_id: string;
  connector_slug: string;
  observed_hash: string;
  observed_tool_count: number;
  auditCtx: {
    actor_id: string | null;
    actor_type?: AuditActorType;
    request_source: RequestSource;
    executor?: Executor;
  };
}

interface ReconcileManifestHashResult {
  drifted: boolean;
  previous_hash: string | null;
}

export async function reconcileManifestHash(
  input: ReconcileManifestHashInput,
): Promise<ReconcileManifestHashResult> {
  const {
    db,
    tenant_id,
    connector_id,
    connector_slug,
    observed_hash,
    observed_tool_count,
    auditCtx,
  } = input;

  const rows = await db
    .select({ previous_hash: connectorMcpSessions.tools_manifest_hash })
    .from(connectorMcpSessions)
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, tenant_id),
        eq(connectorMcpSessions.connector_id, connector_id),
      ),
    )
    .limit(1);
  const current = rows[0];
  if (!current) return { drifted: false, previous_hash: null };

  const previous_hash = current.previous_hash ?? null;
  if (previous_hash === null || previous_hash === observed_hash) {
    return { drifted: false, previous_hash };
  }

  if (manifestHashVersion(previous_hash) !== MANIFEST_HASH_VERSION) {
    await db
      .update(connectorMcpSessions)
      .set({ tools_manifest_hash: observed_hash, updated_at: new Date() })
      .where(
        and(
          eq(connectorMcpSessions.tenant_id, tenant_id),
          eq(connectorMcpSessions.connector_id, connector_id),
        ),
      );
    logger.info({
      module: "mcp_client",
      action: "manifest.fingerprint_rebaselined",
      msg: "manifest fingerprint version changed; stored a new baseline instead of reporting drift",
      tenant_id,
      connector_id,
      connector_slug,
      previous_version: manifestHashVersion(previous_hash),
      version: MANIFEST_HASH_VERSION,
      observed_tool_count,
    });
    return { drifted: false, previous_hash };
  }

  await db
    .update(connectorMcpSessions)
    .set({ tools_manifest_hash: observed_hash, updated_at: new Date() })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, tenant_id),
        eq(connectorMcpSessions.connector_id, connector_id),
      ),
    );

  await recordConnectorMcpManifestDrift({
    actor_id: auditCtx.actor_id,
    ...(auditCtx.actor_type ? { actor_type: auditCtx.actor_type } : {}),
    tenant_id,
    connector_id,
    connector_slug,
    previous_hash,
    observed_hash,
    observed_tool_count,
    request_source: auditCtx.request_source,
    ...(auditCtx.executor ? { executor: auditCtx.executor } : {}),
  });

  logger.warn({
    module: "self-healing",
    action: "mcp.manifest_drift",
    msg: "external MCP server tool manifest changed",
    tenant_id,
    connector_id,
    connector_slug,
    previous_hash,
    observed_hash,
    observed_tool_count,
  });

  const { invalidateCachedManifest } = await import("./pool.ts");
  invalidateCachedManifest(tenant_id, connector_id);

  return { drifted: true, previous_hash };
}
