import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import {
  conversationDrafts,
  conversations,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { executionVisibilityFilter } from "../execution/execution-owner.ts";
import { isSensitivePayload } from "../execution/sensitive-payload.ts";
import { readStoredSpec, workflowSpecDigest } from "../workflows/core/spec.ts";
import { workflowUsesSandboxedJs } from "../workflows/runtime-annotation.ts";
import { buildScopeAtStep } from "../workflows/scope-shape.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { normalizeWorkflowDraft } from "./authoring-state/normalize.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  normalizeDraftDocument,
  refreshDraftSummary,
} from "./authoring-state.ts";
import { canonicalJson } from "./text-line-diff.ts";
import { stepWarningSources } from "./tools/execution-diagnosis.ts";
import type {
  DraftDocument,
  LatestExecutionSummary,
  WorkflowDraftDocument,
  WorkflowDraftStepPreview,
} from "./types.ts";

function emptyDraft(): DraftDocument {
  return createEmptyDraftDocument();
}

function padOrdinal(n: number): string {
  return n.toString().padStart(6, "0");
}

function workflowDraftFromDag(dag: unknown): WorkflowDraftDocument | null {
  if (typeof dag !== "object" || dag === null || Array.isArray(dag)) return null;
  const name = (dag as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) return null;
  return normalizeWorkflowDraft({ workflow: dag });
}

async function buildPreviewFromLastExecution(
  tenant_id: string,
  workflow_id: string,
  workflow_version_id: string,
  exec: Executor,
  principal?: ResolvedPrincipal,
): Promise<DraftDocument["latest_preview"] | null> {
  const executionRows = await exec
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        eq(executions.workflow_version_id, workflow_version_id),
        principal
          ? executionVisibilityFilter(principal)
          : sql`${executions.caller_context}->>'productId' is null`,
        sql`coalesce(${executions.input}->>'$sensitive', 'false') <> 'true'`,
        sql`${executions.sensitive_result} is null`,
        eq(executions.status, "succeeded"),
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(1);
  const execution = executionRows[0];
  if (!execution) return null;
  const stepRows = await exec
    .select({
      step_key: executionSteps.step_key,
      kind: executionSteps.kind,
      status: executionSteps.status,
      duration_ms: executionSteps.duration_ms,
      output_preview: executionSteps.output_preview,
      error: executionSteps.error,
    })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, execution.id)),
    )
    .orderBy(executionSteps.step_index, executionSteps.started_at);
  if (stepRows.length === 0) return null;
  const step_traces: WorkflowDraftStepPreview[] = stepRows.map((row) => {
    const errorCode =
      row.error && typeof row.error === "object" && row.error !== null
        ? (row.error as { code?: unknown }).code
        : undefined;
    const scope =
      row.output_preview !== undefined && row.output_preview !== null
        ? buildScopeAtStep(row.output_preview)
        : undefined;
    return {
      step_id: row.step_key,
      kind: row.kind,
      status: row.status,
      ...(row.duration_ms != null ? { duration_ms: row.duration_ms } : {}),
      ...(row.output_preview !== undefined && row.output_preview !== null
        ? { output_preview: row.output_preview }
        : {}),
      ...(scope ? { scope_at_step: scope } : {}),
      ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
    };
  });
  const lastStep = stepRows[stepRows.length - 1];
  return {
    ok: true,
    step_id: lastStep?.step_key ?? null,
    summary: "Recorded from the workflow's most recent succeeded execution.",
    step_traces,
  };
}

export async function hydrateBoundWorkflow(
  tenant_id: string,
  target_workflow_id: string | null,
  draft: DraftDocument,
  exec: Executor,
  principal?: ResolvedPrincipal,
): Promise<DraftDocument> {
  const normalized = normalizeDraftDocument(draft);
  if (!target_workflow_id) return normalized;
  const alreadyBound = normalized.summary?.persisted_resources.some(
    (resource) => resource.kind === "workflow" && resource.id === target_workflow_id,
  );
  if (alreadyBound) {
    const state = normalized.state;
    const saved = normalized.summary?.checkpoints.find((item) => item.key === "workflow_persisted");
    const ref = normalized.summary?.persisted_resources.find(
      (item) => item.kind === "workflow" && item.id === target_workflow_id,
    );
    if (
      state &&
      ref?.version_id &&
      (ref.draft_version_id === undefined || ref.draft_version_id === ref.version_id)
    ) {
      const [head] = await exec
        .select({
          current_version_id: workflows.current_version_id,
          draft_version_id: workflows.draft_version_id,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, tenant_id),
            eq(workflows.id, target_workflow_id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      if (head && head.draft_version_id === null && head.current_version_id === ref.version_id) {
        state.persisted_resources = state.persisted_resources.map((resource) =>
          resource.kind === "workflow" && resource.id === target_workflow_id
            ? {
                ...resource,
                draft_version_id: null,
                current_version_id: head.current_version_id,
                persistence_kind: "active" as const,
              }
            : resource,
        );
        const refreshed = refreshDraftSummary(normalized);
        if (refreshed.summary) normalized.summary = refreshed.summary;
      }
    }
    if (state && saved?.ok === true && ref?.version_id) {
      const [version] = await exec
        .select({ dag: workflowVersions.dag, spec: workflowVersions.spec })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            eq(workflowVersions.workflow_id, target_workflow_id),
            eq(workflowVersions.id, ref.version_id),
          ),
        )
        .limit(1);
      const current = WorkflowDefSchema.safeParse(normalized.workflow);
      const persisted = WorkflowDefSchema.safeParse(version?.dag);
      if (current.success && persisted.success && workflowUsesSandboxedJs(current.data)) {
        const [active] = await exec
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, tenant_id),
              eq(workflowVersions.workflow_id, target_workflow_id),
              eq(workflowVersions.id, ref.current_version_id ?? ref.version_id),
            ),
          )
          .limit(1);
        const activeDefinition = WorkflowDefSchema.safeParse(active?.dag);
        if (
          current.data.runtime === undefined ||
          (activeDefinition.success &&
            canonicalJson(current.data.runtime) === canonicalJson(activeDefinition.data.runtime))
        ) {
          current.data.runtime = persisted.data.runtime;
        }
      }
      const sameSpec =
        workflowSpecDigest(normalized.workflow?.spec) ===
        workflowSpecDigest(readStoredSpec(version?.spec));
      const sameDefinition =
        sameSpec &&
        (current.success && persisted.success
          ? canonicalJson(current.data) === canonicalJson(persisted.data)
          : version &&
            canonicalJson(normalized.workflow) ===
              canonicalJson(workflowDraftFromDag(version.dag)));
      if (sameDefinition) {
        const checkpoint = state.checkpoints.workflow_persisted;
        if (checkpoint) checkpoint.mutation_seq = state.workflow_mutation_seq;
        return refreshDraftSummary({ ...normalized, state });
      }
      if (saved.status === "fresh") {
        state.workflow_mutation_seq += 1;
        return refreshDraftSummary({ ...normalized, state });
      }
    }
    return normalized;
  }
  const workflowRows = await exec
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
      draft_version_id: workflows.draft_version_id,
      updated_at: workflows.updated_at,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, target_workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const workflow = workflowRows[0];
  if (!workflow) return normalized;
  let version: number | null = null;
  let hydratedWorkflow: WorkflowDraftDocument | null = null;
  const selectedVersionId = workflow.draft_version_id ?? workflow.current_version_id;
  if (selectedVersionId) {
    const versionRows = await exec
      .select({
        version: workflowVersions.version,
        dag: workflowVersions.dag,
        spec: workflowVersions.spec,
      })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.id, selectedVersionId),
          eq(workflowVersions.workflow_id, workflow.id),
        ),
      )
      .limit(1);
    version = versionRows[0]?.version ?? null;
    hydratedWorkflow = versionRows[0]?.dag ? workflowDraftFromDag(versionRows[0].dag) : null;
    const storedSpec = readStoredSpec(versionRows[0]?.spec);
    if (hydratedWorkflow && storedSpec)
      hydratedWorkflow = { ...hydratedWorkflow, spec: storedSpec };
  }
  const draftToBind: DraftDocument =
    hydratedWorkflow && hydratedWorkflow.steps.length > 0
      ? { ...normalized, workflow: hydratedWorkflow }
      : normalized;
  const seededPreview = selectedVersionId
    ? await buildPreviewFromLastExecution(
        tenant_id,
        workflow.id,
        selectedVersionId,
        exec,
        principal,
      )
    : null;
  const withPreview: DraftDocument = seededPreview
    ? { ...draftToBind, latest_preview: seededPreview }
    : draftToBind;
  return bindPersistedWorkflow(withPreview, {
    kind: "workflow",
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    version_id: selectedVersionId,
    draft_version_id: workflow.draft_version_id,
    current_version_id: workflow.current_version_id,
    persistence_kind: workflow.draft_version_id ? "draft" : "active",
    version,
    environment: null,
    saved_at: workflow.updated_at.toISOString(),
  });
}

export async function loadFocusExecution(
  tenant_id: string,
  execution_id: string,
  exec: Executor,
  principal?: ResolvedPrincipal,
): Promise<LatestExecutionSummary | null> {
  const [row] = await exec
    .select({
      id: executions.id,
      input: executions.input,
      sensitive_result: executions.sensitive_result,
      workflow_id: executions.workflow_id,
      workflow_version_id: executions.workflow_version_id,
      status: executions.status,
      execution_mode: executions.execution_mode,
      finished_at: executions.finished_at,
      created_at: executions.created_at,
    })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.id, execution_id),
        principal
          ? executionVisibilityFilter(principal)
          : sql`${executions.caller_context}->>'productId' is null`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const sensitive = isSensitivePayload(row.input) || isSensitivePayload(row.sensitive_result);
  const stepRows = sensitive
    ? []
    : await exec
        .select({
          step_key: executionSteps.step_key,
          output_preview: executionSteps.output_preview,
          request_meta: executionSteps.request_meta,
        })
        .from(executionSteps)
        .where(
          and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, row.id)),
        );
  return {
    execution_id: row.id,
    workflow_id: row.workflow_id,
    workflow_version_id: row.workflow_version_id,
    status: row.status,
    environment: row.execution_mode,
    warnings_count: stepWarningSources(stepRows).length,
    recorded_at: (row.finished_at ?? row.created_at).toISOString(),
    diagnosis_available: !sensitive,
  };
}

export async function loadDraft(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
  principal?: ResolvedPrincipal,
): Promise<DraftDocument> {
  const conversationRows = await exec
    .select({
      draft: conversations.draft,
      target_workflow_id: conversations.target_workflow_id,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  const conversation = conversationRows[0];
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal))
    .limit(1);
  const row = rows[0];
  if (!row) {
    const draft = conversation?.draft;
    if (draft && typeof draft === "object") {
      return hydrateBoundWorkflow(
        tenant_id,
        conversation?.target_workflow_id ?? null,
        normalizeDraftDocument(draft),
        exec,
        principal,
      );
    }
    return hydrateBoundWorkflow(
      tenant_id,
      conversation?.target_workflow_id ?? null,
      emptyDraft(),
      exec,
      principal,
    );
  }
  return hydrateBoundWorkflow(
    tenant_id,
    conversation?.target_workflow_id ?? null,
    normalizeDraftDocument(row.snapshot),
    exec,
    principal,
  );
}

export async function appendSnapshot(
  tenant_id: string,
  conversation_id: string,
  draft: DraftDocument,
  exec: Executor,
): Promise<void> {
  const [row] = (await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )) as Array<{ n: number }>;
  const next = (row?.n ?? 0) + 1;
  const normalized = normalizeDraftDocument(draft);
  await exec.insert(conversationDrafts).values({
    tenant_id,
    conversation_id,
    ordinal: padOrdinal(next),
    snapshot: normalized as unknown as Record<string, unknown>,
  });
  await exec
    .update(conversations)
    .set({ draft: normalized as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
}

export async function undoLastSnapshot(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<DraftDocument> {
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal));
  if (rows.length === 0) return emptyDraft();
  const head = rows[0];
  if (!head) return emptyDraft();
  await exec.delete(conversationDrafts).where(eq(conversationDrafts.id, head.id));
  const next = rows[1];
  const draft = normalizeDraftDocument(
    (next?.snapshot as DraftDocument | undefined) ?? emptyDraft(),
  );
  await exec
    .update(conversations)
    .set({ draft: draft as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
  return draft;
}
