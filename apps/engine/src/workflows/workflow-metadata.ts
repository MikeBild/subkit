import { and, eq } from "drizzle-orm";
import { type CatalogMetadataPatch, metadataChange } from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";

export async function writeWorkflowMetadata(
  tx: Executor,
  wf: { id: string; tenant_id: string; description: string | null; category: string },
  patch: CatalogMetadataPatch,
  actor: { actor_id: string | null; actor_type?: AuditActorType },
): Promise<boolean> {
  const change = metadataChange(wf, patch);
  if (!change) return false;
  const [updated] = await tx
    .update(workflows)
    .set({ ...change, updated_at: new Date() })
    .where(and(eq(workflows.tenant_id, wf.tenant_id), eq(workflows.id, wf.id)))
    .returning({ category: workflows.category });
  await auditAwait(
    {
      tenant_id: wf.tenant_id,
      actor_type: actor.actor_type ?? (actor.actor_id ? "user" : "system"),
      actor_id: actor.actor_id,
      action: AuditAction.CATALOG_METADATA_UPDATED,
      resource_type: "workflow",
      resource_id: wf.id,
      result: "success",
      before: { description: wf.description, category: wf.category },
      after: {
        description: change.description === undefined ? wf.description : change.description,
        category: updated?.category ?? wf.category,
      },
    },
    tx,
  );
  return true;
}
