import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type CatalogMetadataPatch,
  humanMetadataWrite,
  metadataChange,
} from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import {
  canonicalWorkflowJson as canonical,
  definitionWithoutDescription,
  workflowJsonDigest,
} from "./canonical-json.ts";
import { applySkillSchemaGate, applyStorageBindingGate } from "./commit-gates.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import { slugConflictResult } from "./slug-conflict.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export interface WorkflowDraftView {
  workflow_id: string;
  version_id: string;
  version: number;
  digest: string;
  current_version_id: string | null;
  definition: WorkflowDef;
}

type DraftErrorCode = "invalid_definition" | "not_found" | "draft_conflict" | "slug_conflict";
export type SaveWorkflowDraftResult =
  | { draft: WorkflowDraftView; errors?: never; code?: never }
  | { draft?: never; errors: string[]; code: DraftErrorCode };

export interface SaveWorkflowDraftInput {
  tenant_id: string;
  workflow_id?: string;
  expected_draft_version_id?: string | null;
  def: unknown;
  scope_index?: typeof workflowVersions.$inferInsert.scope_index;
  actor_id: string | null;
  actor_type?: "user" | "system_account" | "system";
  request_source: RequestSource;
  audit_metadata?: Record<string, unknown>;
  metadata?: CatalogMetadataPatch;
}

function draftView(
  wf: typeof workflows.$inferSelect,
  version: typeof workflowVersions.$inferSelect,
): WorkflowDraftView {
  const stored = definitionWithoutDescription(WorkflowDefSchema.parse(version.dag));
  const definition: WorkflowDef = wf.description
    ? { ...stored, description: wf.description }
    : stored;
  return {
    workflow_id: wf.id,
    version_id: version.id,
    version: version.version,
    digest: workflowJsonDigest(definitionWithoutDescription(version.dag)),
    current_version_id: wf.current_version_id,
    definition,
  };
}

export async function getWorkflowDraft(
  tenant_id: string,
  workflow_id: string,
  exec: Executor = getDb(),
): Promise<WorkflowDraftView | null> {
  const [row] = await exec
    .select({ wf: workflows, version: workflowVersions })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.id, workflows.draft_version_id),
        eq(workflowVersions.workflow_id, workflows.id),
        eq(workflowVersions.tenant_id, workflows.tenant_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return row ? draftView(row.wf, row.version) : null;
}

export async function saveWorkflowDraft(
  input: SaveWorkflowDraftInput,
  exec: Executor = getDb(),
): Promise<SaveWorkflowDraftResult> {
  const validation = validateWorkflowDef(input.def);
  if (!validation.ok || !validation.workflow) {
    return {
      code: "invalid_definition",
      errors: validation.errors.map((e) => `${e.path}: ${e.message}`),
    };
  }
  if (input.workflow_id && input.expected_draft_version_id === undefined) {
    return { code: "draft_conflict", errors: ["read the current draft version before updating"] };
  }
  const skillGate = await applySkillSchemaGate(input.tenant_id, validation.workflow, exec);
  if (!skillGate.ok) return { code: "invalid_definition", errors: skillGate.errors };
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, exec);
  if (!storageGate.ok) return { code: "invalid_definition", errors: storageGate.errors };
  const def = annotateRuntime(validation.workflow);
  const metadataPatch: CatalogMetadataPatch = {
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...input.metadata,
  };
  const slug =
    def.slug ??
    (def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) ||
      `wf-${randomUUID().slice(0, 8)}`);
  try {
    return await exec.transaction(async (tx): Promise<SaveWorkflowDraftResult> => {
      let wf: typeof workflows.$inferSelect;
      if (input.workflow_id) {
        const existing = await lockWorkflowForVersionWrite(tx, input.tenant_id, input.workflow_id);
        if (!existing) return { code: "not_found", errors: ["workflow not found"] };
        wf = existing;
        if (wf.draft_version_id !== input.expected_draft_version_id) {
          return { code: "draft_conflict", errors: ["the draft changed; reload before saving"] };
        }
        if (wf.draft_version_id) {
          const previous = await getWorkflowDraft(input.tenant_id, wf.id, tx);
          if (
            previous &&
            previous.digest === workflowJsonDigest(definitionWithoutDescription(def))
          ) {
            if (input.scope_index === undefined) return { draft: previous };
            const [stored] = await tx
              .select({ scope_index: workflowVersions.scope_index })
              .from(workflowVersions)
              .where(
                and(
                  eq(workflowVersions.tenant_id, input.tenant_id),
                  eq(workflowVersions.workflow_id, wf.id),
                  eq(workflowVersions.id, previous.version_id),
                ),
              )
              .limit(1);
            if (stored && canonical(stored.scope_index) === canonical(input.scope_index)) {
              return { draft: previous };
            }
          }
        }
      } else {
        const [created] = await tx
          .insert(workflows)
          .values({
            tenant_id: input.tenant_id,
            slug,
            name: def.name,
            ...humanMetadataWrite(metadataPatch),
            lifecycle: "draft",
          })
          .returning();
        assertInsertRow(created, "workflows");
        wf = created;
      }
      const [latest] = await tx
        .select({ max: sql<number>`coalesce(max(${workflowVersions.version}), 0)` })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, input.tenant_id),
            eq(workflowVersions.workflow_id, wf.id),
          ),
        );
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          tenant_id: input.tenant_id,
          workflow_id: wf.id,
          version: Number(latest?.max ?? 0) + 1,
          dag: definitionWithoutDescription(def),
          scope_index: input.scope_index ?? null,
        })
        .returning();
      assertInsertRow(version, "workflow_versions");
      const metadataUpdate = input.workflow_id ? metadataChange(wf, metadataPatch) : null;
      await tx
        .update(workflows)
        .set({ ...metadataUpdate, draft_version_id: version.id, updated_at: new Date() })
        .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)));
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
          actor_id: input.actor_id,
          action: input.workflow_id ? AuditAction.WORKFLOW_UPDATED : AuditAction.WORKFLOW_CREATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          before: {
            draft_version_id: wf.draft_version_id,
            current_version_id: wf.current_version_id,
          },
          after: { draft_version_id: version.id, current_version_id: wf.current_version_id },
          metadata: {
            ...input.audit_metadata,
            kind: "draft",
            version: version.version,
            request_source: input.request_source,
          },
        },
        tx,
      );
      return { draft: draftView(wf, version) };
    });
  } catch (error) {
    const conflict = await slugConflictResult(error, exec, input.tenant_id, slug);
    if (conflict) return { code: "slug_conflict", errors: conflict.errors };
    throw error;
  }
}
