import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
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
    // biome-ignore lint/suspicious/noExplicitAny: stub for gate test
    engineClient: {} as any,
    getDraft,
    setDraft: async () => {},
  };
}

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

    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
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

    expect(result.ok).toBe(true);
    expect(result.committed_workflow_id).toBe(existing.id);

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

    const convAfter = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conv.id))
      .limit(1);
    expect(convAfter[0]?.target_workflow_id).toBe(existing.id);
  });

  test("a draft whose slug matches a DIFFERENT workflow (not the bound one) still fails with slug_conflict_with_live_workflow", async () => {
    const bound = await seedLiveWorkflow("rc4-bound-wf", "RC4 Bound WF", [
      { id: "s1", kind: "transform", language: "javascript", expression: "return input.input;" },
    ]);
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
    const draft = bindPersistedWorkflow(withPreview, {
      kind: "workflow",
      id: bound.id,
      slug: "rc4-bound-wf",
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

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown; conflict?: { workflow_id?: unknown } };
    expect(data.error_code).toBe("slug_conflict_with_live_workflow");
    expect(data.conflict?.workflow_id).toBe(conflicting.id);
  });
});
