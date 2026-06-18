// External MCP server schema-drift tracker.
//
// A remote MCP server can change its tool manifest at any time — add a
// tool, drop one, change an input schema. We fingerprint the manifest as
// a sha256 of canonical JSON and compare it against the last-observed
// `tools_manifest_hash` persisted on the `mcp_servers` row. When the hash
// changes we: (1) update the durable hash, (2) emit a config_updated
// audit row tagged `tool_manifest_drift`, (3) log a self-healing drift
// warning the operator reads at runtime, and (4) invalidate the pool's
// cached manifest so the next palette assembly re-lists tools.
//
// We deliberately do NOT create a `patch_candidates` row here: that table
// requires `workflow_id NOT NULL` and is the entry point for the LLM
// bounded-repair flow over a specific workflow. Manifest drift on an
// external server is not scoped to a workflow and needs no LLM proposal —
// the pool simply re-reads the live manifest. Conflating the two would
// violate the patch_candidates identity contract.

import { and, eq } from "drizzle-orm";
import { recordMcpServerConfigUpdated } from "../../audit/recorders/index.ts";
import type { Executor } from "../../db/client.ts";
import { mcpServers } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";

export interface ReconcileManifestHashInput {
  db: Executor;
  tenant_id: string;
  mcp_server_id: string;
  observed_hash: string;
  observed_tool_count: number;
  auditCtx: {
    actor_id: string | null;
    request_source: RequestSource;
    executor?: Executor;
  };
}

export interface ReconcileManifestHashResult {
  drifted: boolean;
  previous_hash: string | null;
}

/**
 * Compare the freshly-observed manifest hash against the persisted one.
 * On change: persist the new hash, audit the drift, log it, and signal
 * the pool to invalidate its cached manifest for that server. No-op (no
 * write, no audit) when the hash is unchanged or this is the first
 * handshake (no previous hash) — a first observation is a baseline, not
 * a drift.
 */
export async function reconcileManifestHash(
  input: ReconcileManifestHashInput,
): Promise<ReconcileManifestHashResult> {
  const { db, tenant_id, mcp_server_id, observed_hash, observed_tool_count, auditCtx } = input;

  const rows = await db
    .select({
      namespace: mcpServers.namespace,
      previous_hash: mcpServers.tools_manifest_hash,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, mcp_server_id)))
    .limit(1);
  const current = rows[0];
  if (!current) return { drifted: false, previous_hash: null };

  const previous_hash = current.previous_hash ?? null;
  // First observation (no baseline) or identical hash → not a drift.
  if (previous_hash === null || previous_hash === observed_hash) {
    return { drifted: false, previous_hash };
  }

  await db
    .update(mcpServers)
    .set({ tools_manifest_hash: observed_hash, updated_at: new Date() })
    .where(and(eq(mcpServers.tenant_id, tenant_id), eq(mcpServers.id, mcp_server_id)));

  await recordMcpServerConfigUpdated({
    actor_id: auditCtx.actor_id,
    tenant_id,
    mcp_server_id,
    namespace: current.namespace,
    changed_fields: ["tools_manifest_hash"],
    reason: "tool_manifest_drift",
    request_source: auditCtx.request_source,
    ...(auditCtx.executor ? { executor: auditCtx.executor } : {}),
  });

  logger.warn({
    module: "self-healing",
    action: "mcp.manifest_drift",
    msg: "external MCP server tool manifest changed",
    tenant_id,
    mcp_server_id,
    namespace: current.namespace,
    previous_hash,
    observed_hash,
    observed_tool_count,
  });

  // Signal the pool to drop its cached manifest for this server so the
  // next palette assembly re-lists tools. Imported lazily to avoid a
  // static import cycle (pool.ts imports this module).
  const { invalidateCachedManifest } = await import("./pool.ts");
  invalidateCachedManifest(tenant_id, mcp_server_id);

  return { drifted: true, previous_hash };
}
