import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type CatalogMetadataPatch, humanMetadataWrite } from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { CatalogVocabularyBusyError, lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Executor, getDb } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { canonicalWorkflowJson as canonical, workflowJsonDigest } from "./canonical-json.ts";
import { applySkillSchemaGate, applyStorageBindingGate } from "./commit-gates.ts";
import { type WorkflowSpec, WorkflowSpecSchema } from "./draft-schemas.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import type { ServicePackageWorkflowSource } from "./service-package-provenance.ts";
import { packageWorkflowNote } from "./service-package-provenance.ts";
import { slugConflictResult } from "./slug-conflict.ts";
import { validateTenantWorkflowDefForSave } from "./tenant-validator.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { type VersionActor, versionAuthorColumns } from "./version-author.ts";
import {
  carriedSpecColumns,
  loadVersionSpec,
  personOriginRefused,
  readStoredSpec,
  type SpecAuthority,
  type SpecCarrier,
  workflowSpecDigest,
} from "./version-spec.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";
import { writeWorkflowMetadata } from "./workflow-metadata.ts";

export interface WorkflowDraftView {
  workflow_id: string;
  version_id: string;
  version: number;
  digest: string;
  current_version_id: string | null;
  definition: WorkflowDef;
  spec: WorkflowSpec | null;
}

type DraftErrorCode =
  | "invalid_definition"
  | "not_found"
  | "draft_base_not_observed"
  | "draft_conflict"
  | "version_conflict"
  | "slug_conflict"
  | "human_confirmation_required";
export type SaveWorkflowDraftResult =
  | { draft: WorkflowDraftView; errors?: never; code?: never; details?: never }
  | {
      draft?: never;
      errors: string[];
      code: DraftErrorCode;
      details?: Record<string, unknown>;
    };

export interface SaveWorkflowDraftInput extends VersionActor {
  tenant_id: string;
  workflow_id?: string;
  expected_draft_version_id?: string | null;
  expected_current_version_id?: string | null;
  def: unknown;
  spec?: unknown;
  spec_authority?: SpecAuthority;
  scope_index?: typeof workflowVersions.$inferInsert.scope_index;
  actor_id: string | null;
  actor_type?: "user" | "system_account" | "system";
  request_source: RequestSource;
  audit_metadata?: Record<string, unknown>;
  metadata?: CatalogMetadataPatch;
  service_package_source?: ServicePackageWorkflowSource;
}

const PERSON_ORIGIN_REFUSAL: SaveWorkflowDraftResult = {
  code: "human_confirmation_required",
  errors: ["only a signed-in person can state a spec as their own; send origin chat or derived"],
};

function draftView(
  wf: typeof workflows.$inferSelect,
  version: typeof workflowVersions.$inferSelect,
): WorkflowDraftView {
  const stored = WorkflowDefSchema.parse(version.dag);
  const definition: WorkflowDef =
    stored.description === undefined && wf.description
      ? { ...stored, description: wf.description }
      : stored;
  return {
    workflow_id: wf.id,
    version_id: version.id,
    version: version.version,
    digest: workflowJsonDigest(version.dag),
    current_version_id: wf.current_version_id,
    definition,
    spec: readStoredSpec(version.spec),
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

async function versionConflict(
  tx: Executor,
  wf: typeof workflows.$inferSelect,
  expected: string | null,
): Promise<SaveWorkflowDraftResult> {
  const [current] = wf.current_version_id
    ? await tx
        .select({ version: workflowVersions.version })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, wf.tenant_id),
            eq(workflowVersions.workflow_id, wf.id),
            eq(workflowVersions.id, wf.current_version_id),
          ),
        )
        .limit(1)
    : [];
  return {
    code: "version_conflict",
    errors: ["a newer workflow version was saved meanwhile; reload before saving"],
    details: {
      expected_current_version_id: expected,
      current_version_id: wf.current_version_id,
      current_version: current?.version ?? null,
    },
  };
}

export async function saveWorkflowDraft(
  input: SaveWorkflowDraftInput,
  exec: Executor = getDb(),
): Promise<SaveWorkflowDraftResult> {
  if (input.workflow_id && input.expected_draft_version_id === undefined) {
    return {
      code: "draft_base_not_observed",
      errors: ["read the current draft version before updating"],
    };
  }
  const requestedSpec =
    input.spec === undefined ? undefined : WorkflowSpecSchema.safeParse(input.spec);
  if (requestedSpec && !requestedSpec.success) {
    return {
      code: "invalid_definition",
      errors: requestedSpec.error.issues.map(
        (issue) => `spec${issue.path.map((part) => `.${String(part)}`).join("")}: ${issue.message}`,
      ),
    };
  }
  if (!input.workflow_id && personOriginRefused(requestedSpec?.data, null, input.spec_authority)) {
    return PERSON_ORIGIN_REFUSAL;
  }
  const validation = await validateTenantWorkflowDefForSave(input.def, input.tenant_id, exec, {
    destinationTier: "tokens",
  });
  if (!validation.ok || !validation.workflow) {
    return {
      code: "invalid_definition",
      errors: validation.errors.map((e) => `${e.path}: ${e.message}`),
    };
  }
  const skillGate = await applySkillSchemaGate(input.tenant_id, validation.workflow, exec);
  if (!skillGate.ok) return { code: "invalid_definition", errors: skillGate.errors };
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, exec);
  if (!storageGate.ok) return { code: "invalid_definition", errors: storageGate.errors };
  const def = annotateRuntime(validation.workflow);
  const defDigest = workflowJsonDigest(def);
  const servicePackageNote =
    input.service_package_source?.definition_hash === defDigest
      ? packageWorkflowNote(input.service_package_source, defDigest)
      : null;
  const createMetadata: CatalogMetadataPatch = {
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
      await lockCatalogVocabulary(tx, input.tenant_id);
      let wf: typeof workflows.$inferSelect;
      let baseSpec: SpecCarrier | null = null;
      if (input.workflow_id) {
        const existing = await lockWorkflowForVersionWrite(tx, input.tenant_id, input.workflow_id);
        if (!existing) return { code: "not_found", errors: ["workflow not found"] };
        wf = existing;
        if (wf.draft_version_id !== input.expected_draft_version_id) {
          return { code: "draft_conflict", errors: ["the draft changed; reload before saving"] };
        }
        if (
          input.expected_current_version_id !== undefined &&
          wf.current_version_id !== input.expected_current_version_id
        ) {
          return await versionConflict(tx, wf, input.expected_current_version_id);
        }
        baseSpec = await loadVersionSpec(tx, {
          tenant_id: input.tenant_id,
          workflow_id: wf.id,
          version_id: wf.draft_version_id ?? wf.current_version_id,
        });
        if (personOriginRefused(requestedSpec?.data, baseSpec?.spec, input.spec_authority)) {
          return PERSON_ORIGIN_REFUSAL;
        }
        const nextSpec = requestedSpec ? requestedSpec.data : (baseSpec?.spec ?? null);
        if (wf.draft_version_id) {
          const previous = await getWorkflowDraft(input.tenant_id, wf.id, tx);
          if (
            previous &&
            previous.digest === workflowJsonDigest(def) &&
            workflowSpecDigest(baseSpec?.spec) === workflowSpecDigest(nextSpec)
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
            ...humanMetadataWrite(createMetadata),
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
      const specColumns = requestedSpec
        ? { spec: requestedSpec.data }
        : carriedSpecColumns(baseSpec);
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          ...versionAuthorColumns(input),
          tenant_id: input.tenant_id,
          workflow_id: wf.id,
          version: Number(latest?.max ?? 0) + 1,
          dag: def,
          note: servicePackageNote,
          ...specColumns,
          scope_index: input.scope_index ?? null,
        })
        .returning();
      assertInsertRow(version, "workflow_versions");
      await tx
        .update(workflows)
        .set({ draft_version_id: version.id, updated_at: new Date() })
        .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)));
      if (input.workflow_id && input.metadata) {
        await writeWorkflowMetadata(tx, wf, input.metadata, {
          actor_id: input.actor_id,
          ...(input.actor_type ? { actor_type: input.actor_type } : {}),
        });
      }
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...resolveActor({
            tenant_id: input.tenant_id,
            actor_id: input.actor_id,
            ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
          }),
          action: input.workflow_id ? AuditAction.WORKFLOW_UPDATED : AuditAction.WORKFLOW_CREATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          ...(typeof input.audit_metadata?.reason === "string"
            ? { reason: input.audit_metadata.reason }
            : {}),
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
      const specBefore = workflowSpecDigest(baseSpec?.spec);
      const specAfter = workflowSpecDigest(version.spec);
      if (specBefore !== specAfter) {
        await auditAwait(
          {
            tenant_id: input.tenant_id,
            ...resolveActor({
              tenant_id: input.tenant_id,
              actor_id: input.actor_id,
              ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
            }),
            action: AuditAction.DRAFT_SPEC_UPDATED,
            resource_type: "workflow",
            resource_id: wf.id,
            result: "success",
            before: {
              version_id: wf.draft_version_id ?? wf.current_version_id,
              spec_digest: baseSpec?.spec ? specBefore : null,
            },
            after: { version_id: version.id, spec_digest: specAfter },
            metadata: {
              version: version.version,
              origin: readStoredSpec(version.spec)?.origin ?? null,
              request_source: input.request_source,
            },
          },
          tx,
        );
      }
      return { draft: draftView(wf, version) };
    });
  } catch (error) {
    if (input.workflow_id && error instanceof CatalogVocabularyBusyError) {
      return { code: "draft_conflict", errors: ["the draft changed; reload before saving"] };
    }
    const conflict = await slugConflictResult(error, exec, input.tenant_id, slug);
    if (conflict) return { code: "slug_conflict", errors: conflict.errors };
    throw error;
  }
}
