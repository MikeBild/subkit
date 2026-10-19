import { and, eq, like, or, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { getConfig, installRuntimeConfig, isConfigLoaded } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import {
  engineRestartRequests,
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "./contracts.ts";
import { clone, configDigest } from "./document.ts";
import { runtimeStateColumns } from "./state-columns.ts";

export async function eraseTenantRuntimeArtifacts(tenantId: string, tx: Executor) {
  // tenant-filter:exempt — lock the global revision pointer while removing only the erased tenant's owned overlay.
  await tx
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .for("update");
  // tenant-filter:exempt — historical revision documents contain isolated tenant overlays and require exact-key redaction.
  const revisions = await tx.select().from(runtimeConfigRevisions);
  const ownedSecretNames = (
    await tx
      .select({ name: runtimeSecretVersions.name })
      .from(runtimeSecretVersions)
      .where(eq(runtimeSecretVersions.tenant_id, tenantId))
  ).map((row) => row.name);
  const cleaned: Array<{
    revision: number;
    document: Record<string, unknown>;
    digest: string;
    previous: string;
  }> = [];
  for (const revision of revisions) {
    const document = clone(revision.document);
    const overlays = document.tenants;
    const tenantOverlays =
      overlays !== null && typeof overlays === "object" && !Array.isArray(overlays)
        ? (overlays as Record<string, unknown>)
        : null;
    if (tenantOverlays && Object.hasOwn(tenantOverlays, tenantId)) delete tenantOverlays[tenantId];
    if (
      JSON.stringify(document).includes(`secret://tenants.${tenantId}.`) ||
      ownedSecretNames.some((name) => JSON.stringify(document).includes(`secret://${name}/`))
    )
      throw new Error("tenant_erasure_shared_secret_reference");
    const digest = configDigest(document);
    if (
      digest !== revision.digest &&
      tenantOverlays &&
      Object.hasOwn(revision.document.tenants as Record<string, unknown>, tenantId)
    )
      cleaned.push({ revision: revision.revision, document, digest, previous: revision.digest });
  }
  for (const revision of cleaned) {
    await tx
      .update(runtimeConfigRevisions)
      .set({ document: revision.document, digest: revision.digest, failure_reason: null })
      .where(eq(runtimeConfigRevisions.revision, revision.revision));
    await tx
      .update(runtimeConfigReplicas)
      .set({ ack_digest: revision.digest })
      .where(
        and(
          eq(runtimeConfigReplicas.ack_revision, revision.revision),
          eq(runtimeConfigReplicas.ack_digest, revision.previous),
        ),
      );
  }
  const secretPrefix = `tenants.${tenantId}.`;
  // tenant-filter:exempt — exact namespace ownership identifies tenant-specific secret versions in the global registry.
  const secrets = await tx
    .delete(runtimeSecretVersions)
    .where(
      or(
        eq(runtimeSecretVersions.tenant_id, tenantId),
        like(runtimeSecretVersions.name, `${secretPrefix}%`),
      ),
    )
    .returning({ name: runtimeSecretVersions.name });
  // tenant-filter:exempt — pending binding paths are global operator metadata; only exact tenant-owned paths are removed.
  const pending = await tx
    .select({
      name: runtimeSecretVersions.name,
      version: runtimeSecretVersions.version,
      pending_bindings: runtimeSecretVersions.pending_bindings,
    })
    .from(runtimeSecretVersions);
  let changedBindings = 0;
  for (const secret of pending) {
    const bindings = secret.pending_bindings?.filter(
      (binding) => !binding.startsWith(secretPrefix),
    );
    if (bindings && bindings.length !== secret.pending_bindings?.length) {
      changedBindings += 1;
      await tx
        .update(runtimeSecretVersions)
        .set({ pending_bindings: bindings })
        .where(
          and(
            eq(runtimeSecretVersions.name, secret.name),
            eq(runtimeSecretVersions.version, secret.version),
          ),
        );
    }
  }
  const requests = await tx
    .delete(engineRestartRequests)
    .where(sql`${engineRestartRequests.request}->>'tenant_id'=${tenantId}`)
    .returning({ key: engineRestartRequests.key });
  if (cleaned.length > 0 || secrets.length > 0 || requests.length > 0 || changedBindings > 0)
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.TENANT_UPDATED,
        resource_type: "tenant",
        resource_id: tenantId,
        result: "success",
        metadata: {
          source: "tenant_erasure_runtime_cleanup",
          revisions: cleaned.length,
          secret_versions: secrets.length,
          restart_requests: requests.length,
          pending_bindings: changedBindings,
        },
      },
      tx,
    );
  return { revisions: cleaned.length, secrets: secrets.length };
}

export function forgetErasedTenantRuntimeConfig(tenantId: string): void {
  if (!isConfigLoaded()) return;
  const config = getConfig();
  if (!Object.hasOwn(config.tenants, tenantId)) return;
  installRuntimeConfig({
    ...config,
    tenants: Object.fromEntries(Object.entries(config.tenants).filter(([id]) => id !== tenantId)),
  });
}
