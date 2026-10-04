import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationDrafts,
  conversations,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import {
  createEmptyDraftDocument,
  withWorkflowDraft,
  withWorkflowPersisted,
} from "../authoring-state.ts";
import { loadDraft } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("draft_workflow_binding");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("loadDraft", () => {
  test("rehydrates the saved workflow binding from target_workflow_id", async () => {
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "berlin-weather",
        name: "Berlin Weather",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [version] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        version: 4,
        dag: {
          name: "Berlin Weather",
          slug: "berlin-weather",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return input.input;",
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("workflow version insert failed");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));

    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        target_workflow_id: workflow.id,
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: {
              execution_id: "exec_123",
              workflow_id: workflow.id,
              workflow_version_id: version.id,
              status: "succeeded",
              environment: "dev",
              warnings_count: 0,
              recorded_at: "2026-04-25T08:05:00.000Z",
              diagnosis_available: false,
            },
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    await ctx.testDb.db.insert(conversationDrafts).values({
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      ordinal: "000001",
      snapshot: conversation.draft as Record<string, unknown>,
    });

    const draft = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(draft.summary?.active_target).toEqual({
      kind: "workflow",
      id: workflow.id,
      slug: "berlin-weather",
      name: "Berlin Weather",
      environment: null,
      lifecycle_state: "persisted",
    });
    expect(draft.summary?.mode).toBe("execution");
    expect(draft.summary?.stage).toBe("workflow_executed");
    expect(draft.summary?.missing_fields).not.toContain("workflow.steps");
    expect(draft.summary?.persisted_resources).toEqual([
      expect.objectContaining({
        kind: "workflow",
        id: workflow.id,
        slug: "berlin-weather",
        name: "Berlin Weather",
        version_id: version.id,
        version: 4,
      }),
    ]);
  });
});

describe("earlier saved-state reconciliation", () => {
  test("ignores the save-time runtime stamp but preserves real unsaved edits without writing", async () => {
    const definition = {
      name: "Report",
      slug: "earlier-report",
      steps: [{ id: "result", kind: "transform", language: "javascript", expression: "return 1;" }],
    };
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        name: definition.name,
        slug: definition.slug,
        lifecycle: "draft",
      })
      .returning();
    if (!workflow) throw new Error("missing workflow");
    const [version] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        version: 1,
        dag: { ...definition, runtime: { stdlib_version: "1.7.0" } },
      })
      .returning();
    if (!version) throw new Error("missing version");
    const saved = withWorkflowPersisted(
      withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), definition),
      {
        kind: "workflow",
        id: workflow.id,
        name: definition.name,
        slug: definition.slug,
        version_id: version.id,
        version: 1,
        environment: null,
        saved_at: "2026-09-15T10:00:00Z",
      },
    );
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        target_workflow_id: workflow.id,
        draft: saved,
      })
      .returning();
    if (!conversation) throw new Error("missing conversation");
    const unchanged = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(unchanged.summary?.checkpoints.find((c) => c.key === "workflow_persisted")?.status).toBe(
      "fresh",
    );
    const [oldVersion] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: workflow.id,
        version: 2,
        dag: { ...definition, runtime: { stdlib_version: "1.6.0" } },
      })
      .returning();
    if (!oldVersion) throw new Error("missing previous active version");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: oldVersion.id, draft_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const inheritedRuntime = structuredClone(saved);
    if (!inheritedRuntime.state) throw new Error("missing state");
    inheritedRuntime.workflow.runtime = { stdlib_version: "1.6.0" };
    const savedRef = inheritedRuntime.state.persisted_resources.find((r) => r.kind === "workflow");
    if (!savedRef) throw new Error("missing saved binding");
    savedRef.current_version_id = oldVersion.id;
    inheritedRuntime.state.workflow_mutation_seq += 1;
    await ctx.testDb.db
      .update(conversations)
      .set({ draft: inheritedRuntime })
      .where(eq(conversations.id, conversation.id));
    const reconciledRuntime = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(
      reconciledRuntime.summary?.checkpoints.find((c) => c.key === "workflow_persisted")?.status,
    ).toBe("fresh");
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: version.id, draft_version_id: null })
      .where(eq(workflows.id, workflow.id));
    const activatedRuntime = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(
      activatedRuntime.summary?.checkpoints.find((c) => c.key === "workflow_persisted")?.status,
    ).toBe("fresh");
    const runtimeEdit = structuredClone(saved);
    runtimeEdit.workflow.runtime = { stdlib_version: "2.0.0" };
    await ctx.testDb.db
      .update(conversations)
      .set({ draft: runtimeEdit })
      .where(eq(conversations.id, conversation.id));
    const changedRuntime = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(
      changedRuntime.summary?.checkpoints.find((c) => c.key === "workflow_persisted")?.status,
    ).toBe("stale");
    // Reproduce the old editor: change content without advancing its revision.
    const earlier = structuredClone(saved);
    earlier.workflow.name = "Revised report";
    await ctx.testDb.db
      .update(conversations)
      .set({ draft: earlier })
      .where(eq(conversations.id, conversation.id));
    const [snapshot] = await ctx.testDb.db
      .insert(conversationDrafts)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.id,
        ordinal: "000001",
        snapshot: earlier,
      })
      .returning();
    if (!snapshot) throw new Error("missing snapshot");
    const repaired = await loadDraft(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(repaired.workflow.name).toBe("Revised report");
    expect(repaired.summary?.checkpoints.find((c) => c.key === "workflow_persisted")?.status).toBe(
      "stale",
    );
    const [stored] = await ctx.testDb.db
      .select({ draft: conversations.draft })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(stored?.draft).toEqual(earlier);
    const [storedSnapshot] = await ctx.testDb.db
      .select({ snapshot: conversationDrafts.snapshot })
      .from(conversationDrafts)
      .where(eq(conversationDrafts.id, snapshot.id));
    expect(storedSnapshot?.snapshot).toEqual(earlier);
    const wrongTenant = await loadDraft(
      "00000000-0000-4000-8000-000000000099",
      conversation.id,
      ctx.testDb.db,
    );
    expect(wrongTenant.workflow.name).not.toBe("Revised report");
  });
});
