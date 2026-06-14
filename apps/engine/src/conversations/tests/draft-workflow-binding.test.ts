import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationDrafts,
  conversations,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
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
