// Integration tests for RC4: commitWorkflowAtomic resolves
// target_workflow_id from the bound resource when the draft slug
// matches — enabling update-in-place without triggering
// slug_conflict_with_live_workflow.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("bound_workflow_update_in_place");
});

afterAll(async () => {
  await ctx.cleanup();
});

// Build a minimal ToolContext for the save tool.
function toolCtx(
  tenantId: string,
  conversationId: string,
  actorId: string,
  getDraft: () => DraftDocument,
): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: tenantId,
    conversation_id: conversationId,
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub for gate test
    engineClient: {} as any,
    getDraft,
    setDraft: async () => {},
  };
}

// Seed a live workflow with one version, return its IDs.
async function seedLiveWorkflow(
  slug: string,
  name: string,
  steps: Array<Record<string, unknown>> = [],
): Promise<{ id: string; version_id: string }> {
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf.id,
      version: 1,
      dag: { name, slug, steps },
    })
    .returning();
  if (!version) throw new Error("seed workflow version failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return { id: wf.id, version_id: version.id };
}

// Build a ready-to-commit draft that:
//   - has a real step (so inspect/validate pass)
//   - has the workflow_persisted checkpoint fresh (from bindPersistedWorkflow)
//   - has latest_preview (so the preview gate passes)
//   - carries the slug + name of the existing persisted workflow
function boundReadyDraft(opts: {
  name: string;
  slug: string;
  workflow_id: string;
  version_id: string;
}): DraftDocument {
  const step = {
    id: "t1",
    kind: "transform",
    language: "javascript",
    expression: "return input.input.n;",
  };
  const base = createEmptyDraftDocument();
  const withStep = {
    ...base,
    workflow: { name: opts.name, slug: opts.slug, steps: [step] },
  };
  const inspected = withWorkflowInspection(withStep);
  const validated = withWorkflowValidation(inspected, true, "Validated.");
  const withPreview = withLatestPreview(validated, {
    ok: true,
    step_id: "t1",
    summary: "Dry-run succeeded.",
  });
  // Bind the persisted resource — this is what loadDraft does after hydration.
  return bindPersistedWorkflow(withPreview, {
    kind: "workflow",
    id: opts.workflow_id,
    slug: opts.slug,
    name: opts.name,
    version_id: opts.version_id,
    draft_version_id: null,
    current_version_id: opts.version_id,
    persistence_kind: "active",
    version: 1,
    environment: null,
    saved_at: "2026-05-01T00:00:00.000Z",
  });
}

describe("commitWorkflowAtomic — RC4: bound workflow resolves update-in-place", () => {
  test("editing a hydrated workflow with the same slug succeeds as update-in-place", async () => {
    const existing = await seedLiveWorkflow("rc4-update-in-place", "RC4 Update In Place", [
      {
        id: "old_step",
        kind: "transform",
        language: "javascript",
        expression: "return input.input;",
      },
    ]);

    // Conversation has no target_workflow_id — simulates the state
    // just after hydration via loadDraft (target not yet written back).
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        // No target_workflow_id — key to the RC4 scenario.
        draft: { workflow: { name: "RC4 Update In Place", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");

    const draft = boundReadyDraft({
      name: "RC4 Update In Place",
      slug: "rc4-update-in-place",
      workflow_id: existing.id,
      version_id: existing.version_id,
    });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );

    // Must succeed as an update-in-place — NOT a slug_conflict_with_live_workflow.
    expect(result.ok).toBe(true);
    // The committed workflow id must be the SAME as the existing one.
    expect(result.committed_workflow_id).toBe(existing.id);

    // A new version row must have been added to the same workflow id.
    const versionRows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, existing.id))
      .orderBy(workflowVersions.version);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2]);
    const [workflowAfter] = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, existing.id));
    expect(workflowAfter?.current_version_id).toBe(existing.version_id);
    expect(workflowAfter?.draft_version_id).toBeTruthy();
    expect(workflowAfter?.draft_version_id).not.toBe(existing.version_id);

    // The conversation must now be pinned to the existing workflow id.
    const convAfter = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conv.id))
      .limit(1);
    expect(convAfter[0]?.target_workflow_id).toBe(existing.id);
  });

  test("a draft whose slug matches a DIFFERENT workflow (not the bound one) still fails with slug_conflict_with_live_workflow", async () => {
    // The bound workflow.
    const bound = await seedLiveWorkflow("rc4-bound-wf", "RC4 Bound WF", [
      { id: "s1", kind: "transform", language: "javascript", expression: "return input.input;" },
    ]);
    // A different workflow occupying the slug the draft uses.
    const conflicting = await seedLiveWorkflow("rc4-conflict-slug", "RC4 Conflict Slug", [
      { id: "s2", kind: "transform", language: "javascript", expression: "return input.input;" },
    ]);

    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "RC4 Conflict", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");

    // Draft is bound to `bound`, but its slug is `rc4-conflict-slug` (a different wf).
    const step = {
      id: "t1",
      kind: "transform",
      language: "javascript",
      expression: "return input.input.n;",
    };
    const base = createEmptyDraftDocument();
    const withStep = {
      ...base,
      workflow: { name: "RC4 Conflict Slug", slug: "rc4-conflict-slug", steps: [step] },
    };
    const inspected = withWorkflowInspection(withStep);
    const validated = withWorkflowValidation(inspected, true, "Validated.");
    const withPreview = withLatestPreview(validated, {
      ok: true,
      step_id: "t1",
      summary: "Dry-run succeeded.",
    });
    // Bound to the FIRST workflow, but slug points to the second — genuine conflict.
    const draft = bindPersistedWorkflow(withPreview, {
      kind: "workflow",
      id: bound.id,
      slug: "rc4-bound-wf", // bound slug differs from the draft slug
      name: "RC4 Bound WF",
      version_id: bound.version_id,
      version: 1,
      environment: null,
      saved_at: "2026-05-01T00:00:00.000Z",
    });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );

    // The draft slug ("rc4-conflict-slug") does NOT match the bound slug
    // ("rc4-bound-wf"), so bound-resolution is skipped. The slug-conflict
    // check fires because "rc4-conflict-slug" belongs to a different wf.
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown; conflict?: { workflow_id?: unknown } };
    expect(data.error_code).toBe("slug_conflict_with_live_workflow");
    expect(data.conflict?.workflow_id).toBe(conflicting.id);
  });
});
