// Draft document CRUD + snapshot history.
//
// Every mutation (`propose_step`, `update_param`, `connect_steps`)
// writes a new row into `conversation_drafts` with an incrementing
// ordinal. The newest ordinal is the live draft; :undo pops the top.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  conversationDrafts,
  conversations,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
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
import type { DraftDocument, WorkflowDraftDocument, WorkflowDraftStepPreview } from "./types.ts";

function emptyDraft(): DraftDocument {
  return createEmptyDraftDocument();
}

function padOrdinal(n: number): string {
  return n.toString().padStart(6, "0");
}

/**
 * Hydrate a `WorkflowDraftDocument` from a persisted `workflow_versions.dag`.
 * Returns null when the dag is not a workflow definition we can hydrate
 * (no name) — a persisted workflow always has one. The field projection
 * is delegated to the canonical `normalizeWorkflowDraft` so a hydrated
 * draft and a freshly-authored draft share one shape contract.
 */
function workflowDraftFromDag(dag: unknown): WorkflowDraftDocument | null {
  if (typeof dag !== "object" || dag === null || Array.isArray(dag)) return null;
  const name = (dag as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) return null;
  // `normalizeWorkflowDraft` reads the workflow doc from `raw.workflow`,
  // so the dag (which IS the workflow def) must be wrapped.
  return normalizeWorkflowDraft({ workflow: dag });
}

/**
 * Build a `latest_preview`-shaped object from the most recent SUCCEEDED
 * execution of a saved workflow. The shape matches what
 * `dry_run_workflow` produces (`step_traces` carrying each step's
 * recorded `output_preview` + a derived `scope_at_step`), so the
 * transform / loop authoring gates see real upstream shape evidence on
 * a freshly-bound workflow that has executed before. Returns null when
 * the workflow has never succeeded — the gate then correctly still
 * requires a fresh dry-run.
 */
async function buildPreviewFromLastExecution(
  tenant_id: string,
  workflow_id: string,
  workflow_version_id: string,
  exec: Executor,
): Promise<DraftDocument["latest_preview"] | null> {
  const executionRows = await exec
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        eq(executions.workflow_version_id, workflow_version_id),
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
    // `step_index` is nullable — add a stable tiebreaker so the trace
    // order (and the `last step` pick below) is deterministic.
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

async function hydrateBoundWorkflow(
  tenant_id: string,
  target_workflow_id: string | null,
  draft: DraftDocument,
  exec: Executor,
): Promise<DraftDocument> {
  const normalized = normalizeDraftDocument(draft);
  if (!target_workflow_id) return normalized;
  // Skip hydration once the draft is already bound to this workflow.
  // `persisted_resources` carries a `workflow` ref only after a prior
  // hydrate/bind, so it is the precise "already hydrated" signal —
  // re-hydrating would clobber legitimate in-progress edits (including
  // an edit that intentionally emptied the step list).
  const alreadyBound = normalized.summary?.persisted_resources.some(
    (resource) => resource.kind === "workflow" && resource.id === target_workflow_id,
  );
  if (alreadyBound) {
    // Old editor snapshots failed to advance the mutation revision. Reconcile
    // against their exact immutable saved version, never against today's head.
    const state = normalized.state;
    const saved = normalized.summary?.checkpoints.find((item) => item.key === "workflow_persisted");
    const ref = normalized.summary?.persisted_resources.find(
      (item) => item.kind === "workflow" && item.id === target_workflow_id,
    );
    // Legacy chats predate draft-base observations. Observe only an empty
    // draft slot while their exact active base is still current. This never
    // adopts another author's draft or resets local changes/checkpoints.
    // Saving still compares expected_draft_version_id=null atomically.
    if (state && ref?.version_id && ref.draft_version_id === undefined) {
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
        .select({ dag: workflowVersions.dag })
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
      // A saved JavaScript draft receives a server-owned runtime stamp. Older
      // chat snapshots may still carry the previously active stamp. Reconcile
      // only that proven inherited value; explicit different runtime edits remain edits.
      if (current.success && persisted.success && workflowUsesSandboxedJs(current.data)) {
        // Keep the saved base stable even after the reviewed draft is activated.
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
      // Legacy definitions can predate today's validation schema. Identical
      // stored content is still saved; schema validity is a separate check.
      const sameDefinition =
        current.success && persisted.success
          ? canonicalJson(current.data) === canonicalJson(persisted.data)
          : version &&
            canonicalJson(normalized.workflow) === canonicalJson(workflowDraftFromDag(version.dag));
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
      .select({ version: workflowVersions.version, dag: workflowVersions.dag })
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
  }
  // Load the current version's steps into the draft so update_param /
  // propose_step see a populated workflow, and align the draft's
  // slug/name with the saved workflow so subsequent edits and the
  // commit target the same row. Without this the draft is empty and
  // every step-mutation tool reports "unknown_step".
  const draftToBind: DraftDocument =
    hydratedWorkflow && hydratedWorkflow.steps.length > 0
      ? { ...normalized, workflow: hydratedWorkflow }
      : normalized;
  // Seed latest_preview from the most recent succeeded run so the
  // transform / loop authoring gates have real upstream shape evidence
  // on a workflow that has executed before.
  const seededPreview = selectedVersionId
    ? await buildPreviewFromLastExecution(tenant_id, workflow.id, selectedVersionId, exec)
    : null;
  const withPreview: DraftDocument = seededPreview
    ? { ...draftToBind, latest_preview: seededPreview }
    : draftToBind;
  // bindPersistedWorkflow records the `workflow_persisted` checkpoint
  // at the current `workflow_mutation_seq` without advancing it — so
  // the hydrated draft equals the persisted version (checkpoint fresh,
  // lifecycle "persisted", stage "workflow_persisted"); it does not
  // look dirty immediately after load.
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

/**
 * Load the live draft for a conversation. Returns a fresh empty
 * document if none exists yet.
 */
export async function loadDraft(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
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
    // Fall back to the `conversations.draft` column in case a caller
    // seeded it via the service.
    const draft = conversation?.draft;
    if (draft && typeof draft === "object") {
      return hydrateBoundWorkflow(
        tenant_id,
        conversation?.target_workflow_id ?? null,
        normalizeDraftDocument(draft),
        exec,
      );
    }
    return hydrateBoundWorkflow(
      tenant_id,
      conversation?.target_workflow_id ?? null,
      emptyDraft(),
      exec,
    );
  }
  return hydrateBoundWorkflow(
    tenant_id,
    conversation?.target_workflow_id ?? null,
    normalizeDraftDocument(row.snapshot),
    exec,
  );
}

/**
 * Append a new snapshot. `mutate` receives the current draft and
 * returns the new one — mutating in place is fine because we clone
 * the argument first.
 */
export async function appendSnapshot(
  tenant_id: string,
  conversation_id: string,
  draft: DraftDocument,
  exec: Executor,
): Promise<void> {
  // Ordinal is monotonic — compute as count + 1 over the live set.
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
  // Mirror to conversations.draft for easy reads.
  await exec
    .update(conversations)
    .set({ draft: normalized as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
}

/**
 * Pop the most recent snapshot, restoring the previous one. Returns
 * the now-current draft (or the empty draft if the history is empty).
 */
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
