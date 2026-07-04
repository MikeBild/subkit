import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationDrafts,
  conversations,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { getConversation } from "../service.ts";
import type { DraftDocument } from "../types.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("save_workflow_regressions");
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(input: { name: string; slug: string }): DraftDocument {
  return withLatestPreview(
    withWorkflowValidation(
      withWorkflowInspection(
        withWorkflowDraft(createEmptyDraftDocument(), {
          name: input.name,
          slug: input.slug,
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return input.input;",
            },
          ],
        }),
      ),
      true,
      "Workflow draft validated.",
    ),
    {
      ok: true,
      step_id: "shape",
      summary: "Previewed shape in 1ms.",
    },
  );
}

async function seedLiveWorkflow(slug: string, name: string): Promise<{ id: string }> {
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
      dag: {
        name,
        slug,
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
  if (!version) throw new Error("seed workflow version failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));
  return { id: wf.id };
}

describe("workflow save regressions", () => {
  test("a short auto-mode approval follows the draft summary into save_workflow_draft", async () => {
    const draft = {
      ...readyDraft({
        name: "GitHub Private Repos by Owner",
        slug: "github-private-repos-octocat-auto-confirm",
      }),
      session: { permission_mode: "auto" as const },
    };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        owner_id: ctx.user_id,
        draft: draft as unknown as Record<string, unknown>,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    await ctx.testDb.db.insert(conversationDrafts).values({
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      ordinal: "000001",
      snapshot: draft as unknown as Record<string, unknown>,
    });

    getMockProvider().setConversePlan(conversation.id, [{ tool: "save_workflow_draft", args: {} }]);

    const result = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.id,
        actor_id: ctx.user_id,
        message: "yes",
        permission_mode: "auto",
      },
      ctx.testDb.db,
    );

    expect(result.result.status).toBe("committed");
    expect(result.result.committed_workflow_id).toBeTruthy();

    const detail = await getConversation(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBe(result.result.committed_workflow_id);
    expect(detail?.tool_calls.map((call) => call.tool)).toContain("save_workflow_draft");
    expect(detail?.tool_calls.map((call) => call.tool)).not.toContain("ask_user_confirm");
  });

  test("auto mode continues past ask_user_confirm and commits in the same turn", async () => {
    const draft = {
      ...readyDraft({
        name: "GitHub Private Repos by Owner",
        slug: "github-private-repos-octocat",
      }),
      session: { permission_mode: "auto" as const },
    };
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        owner_id: ctx.user_id,
        draft: draft as unknown as Record<string, unknown>,
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");
    await ctx.testDb.db.insert(conversationDrafts).values({
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      ordinal: "000001",
      snapshot: draft as unknown as Record<string, unknown>,
    });

    getMockProvider().setConversePlan(conversation.id, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Save the workflow now?",
          kind: "save_workflow_draft",
          summary: "Workflow: GitHub Private Repos by Owner",
        },
      },
      { tool: "save_workflow_draft", args: {} },
    ]);

    const result = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversation.id,
        actor_id: ctx.user_id,
        message: "yes",
        permission_mode: "auto",
      },
      ctx.testDb.db,
    );

    expect(result.result.status).toBe("committed");
    expect(result.result.committed_workflow_id).toBeTruthy();

    const detail = await getConversation(ctx.tenant_id, conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBe(result.result.committed_workflow_id);
  });

  test("explicit new-workflow intent detaches the previous saved workflow target before authoring", async () => {
    const existing = await seedLiveWorkflow("berlin-weather", "Berlin Weather");
    const created = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        workflow_id: existing.id,
        permission_mode: "auto",
      },
      ctx.testDb.db,
    );

    getMockProvider().setConversePlan(created.conversation.id, [
      {
        tool: "edit_workflow_patch",
        args: {
          patches: [
            { op: "replace", path: "/name", value: "GitHub Private Repos by Owner" },
            { op: "add", path: "/slug", value: "github-private-repos-octocat" },
            { op: "add", path: "/steps/-", value: { id: "shape", kind: "wait", duration_ms: 1 } },
          ],
        },
      },
    ]);

    await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        actor_id: ctx.user_id,
        message: "create a workflow that gives me my private repos by owner octocat",
        permission_mode: "auto",
      },
      ctx.testDb.db,
    );

    const detail = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBeNull();
    expect(detail?.draft?.workflow.name).toBe("GitHub Private Repos by Owner");
    expect(detail?.draft?.workflow.slug).toBe("github-private-repos-octocat");
    expect(detail?.draft?.summary?.active_target).toEqual({
      kind: "workflow",
      id: null,
      slug: "github-private-repos-octocat",
      name: "GitHub Private Repos by Owner",
      environment: null,
      lifecycle_state: "draft_only",
    });
  });
});
