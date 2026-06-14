// Locks the no-silent-slug-adopt contract on save_workflow_draft.
//
// Background: a user starts a brand-new workflow draft ("Berlin Weather
// Tomorrow") in a conversation with no target_workflow_id. The LLM
// emits draft.slug = "list-private-github-repos" (a slug that already
// belongs to a different live workflow in the tenant). Old behaviour:
// save_workflow_draft silently adopted that workflow as the target and
// overwrote its content. The user noticed only after listing workflows
// and seeing "list-private-github-repos (active) — Berlin Weather
// Tomorrow" — same id, content of a totally different workflow.
//
// New contract: a slug collision against a different live workflow id
// returns slug_conflict_with_live_workflow with the conflict's id +
// name. To overwrite, the LLM must call save_workflow_draft again with
// target_workflow_id=<conflict.id> AFTER the user has confirmed in chat.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import {
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
  ctx = await createConversationTestCtx("slug_conflict_with_live_workflow");
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

async function seedApprovedConfirm(conversationId: string): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: "ask_user_confirm",
    summary: "commit",
    input: { kind: "save_workflow_draft", summary: "commit" },
    output: { confirmed: true },
    status: "resolved",
  });
}

function readyDraft(input: { name: string; slug: string }): DraftDocument {
  return withLatestPreview(
    withWorkflowValidation(
      withWorkflowInspection({
        workflow: {
          name: input.name,
          slug: input.slug,
          steps: [
            {
              id: "t1",
              kind: "transform",
              language: "javascript",
              expression: "return input.input.n;",
            },
          ],
        },
      }),
      true,
      "Workflow draft validated.",
    ),
    {
      ok: true,
      step_id: "t1",
      summary: "Previewed t1 in 1ms.",
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
            id: "p1",
            kind: "transform",
            language: "javascript",
            expression: "return input.input.preexisting;",
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

describe("save_workflow_draft — slug-conflict-with-live-workflow contract", () => {
  test("refuses to silently overwrite a different live workflow with the same slug", async () => {
    const existing = await seedLiveWorkflow(
      "list-private-github-repos",
      "List Private GitHub Repos",
    );

    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        // No target_workflow_id — this is a brand-new authoring conversation.
        draft: { workflow: { name: "Berlin Weather Tomorrow", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = readyDraft({
      name: "Berlin Weather Tomorrow",
      // LLM accidentally emits the colliding slug.
      slug: "list-private-github-repos",
    });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );

    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code?: unknown;
      attempted_slug?: unknown;
      conflict?: { workflow_id?: unknown; name?: unknown };
      recovery?: { overwrite?: unknown; rename?: unknown };
    };
    expect(data.error_code).toBe("slug_conflict_with_live_workflow");
    expect(data.attempted_slug).toBe("list-private-github-repos");
    expect(data.conflict?.workflow_id).toBe(existing.id);
    expect(data.conflict?.name).toBe("List Private GitHub Repos");
    expect(typeof data.recovery?.overwrite).toBe("string");
    expect(typeof data.recovery?.rename).toBe("string");

    // Critical: the existing workflow MUST NOT have been mutated.
    const refetched = await ctx.testDb.db
      .select({ name: workflows.name })
      .from(workflows)
      .where(eq(workflows.id, existing.id))
      .limit(1);
    expect(refetched[0]?.name).toBe("List Private GitHub Repos");
    const versionRows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, existing.id));
    expect(versionRows.length).toBe(1);
    expect(versionRows[0]?.version).toBe(1);

    // Conversation must NOT have been silently pinned to the conflicting workflow.
    const convAfter = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conv.id))
      .limit(1);
    expect(convAfter[0]?.target_workflow_id).toBeNull();
  });

  test("explicit target_workflow_id arg adopts after user confirmation in chat", async () => {
    const existing = await seedLiveWorkflow("invoices-export", "Invoices Export");

    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "Invoices Export v2", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = readyDraft({ name: "Invoices Export v2", slug: "invoices-export" });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      { target_workflow_id: existing.id },
    );

    expect(result.ok).toBe(true);
    expect(result.committed_workflow_id).toBe(existing.id);

    // The existing workflow row was updated in place — a v2 row was added.
    const versionRows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, existing.id))
      .orderBy(workflowVersions.version);
    expect(versionRows.map((r) => r.version)).toEqual([1, 2]);

    // The conversation is now pinned for follow-up edits.
    const convAfter = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conv.id))
      .limit(1);
    expect(convAfter[0]?.target_workflow_id).toBe(existing.id);
  });

  test("rejects an explicit target_workflow_id that does not exist in this tenant", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "Phantom", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = readyDraft({ name: "Phantom", slug: "phantom-target" });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      // Valid UUID shape but no row in this tenant.
      { target_workflow_id: "00000000-0000-0000-0000-000000000000" },
    );

    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown };
    expect(data.error_code).toBe("target_workflow_not_found");
  });

  test("creates a new workflow when the slug is free", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "Fresh Start", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = readyDraft({ name: "Fresh Start", slug: "fresh-start-unique" });

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );

    expect(result.ok).toBe(true);
    expect(typeof result.committed_workflow_id).toBe("string");
  });
});
