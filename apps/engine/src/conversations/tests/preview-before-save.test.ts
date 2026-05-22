// Preview-before-commit gate — save_workflow_draft refuses without a successful
// dry-run on record. Legacy force-like fields must not bypass the gate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversationElicitations, conversations } from "../../db/schema/index.ts";
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
  ctx = await createConversationTestCtx("preview-before-commit");
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
    // The commit gate authorizes on `commit_intent.kind` — the
    // authoritative field — not the cosmetic top-level `kind`.
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
    output: { confirmed: true },
    status: "resolved",
  });
}

describe("save_workflow_draft preview-before-commit gate", () => {
  function buildValidatedDraft(base: DraftDocument): DraftDocument {
    return withWorkflowValidation(withWorkflowInspection(base), true, "Workflow draft validated.");
  }

  test("refuses commit when no successful preview is recorded", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "no-preview", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = buildValidatedDraft({
      workflow: {
        name: "no-preview",
        slug: "no-preview",
        steps: [{ id: "s1", kind: "transform", expression: "$input.n", language: "jsonata" }],
      },
      // No latest_preview — gate must refuse.
    });
    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown; stale_checkpoints?: unknown };
    expect(data.error_code).toBe("workflow_not_ready");
    expect(data.stale_checkpoints).toEqual(expect.arrayContaining(["workflow_previewed"]));
  });

  test("legacy force-like fields do not bypass the preview gate", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "forced", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = buildValidatedDraft({
      workflow: {
        name: "forced-commit",
        slug: "forced-preview-gate",
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            url: "https://example.invalid/health",
          },
        ],
      },
    });
    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      { force: true },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: unknown };
    expect(data.error_code).toBe("workflow_not_ready");

    const rows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "workflow.committed_override"),
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("commits without force when the draft carries a successful preview", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "previewed", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft = withLatestPreview(
      buildValidatedDraft({
        workflow: {
          name: "previewed-commit",
          slug: "previewed-preview-gate",
          steps: [{ id: "t1", kind: "transform", expression: "$input.n", language: "jsonata" }],
        },
      }),
      {
        ok: true,
        step_id: "t1",
        summary: "Previewed t1 in 1ms.",
      },
    );
    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    expect(result.ok).toBe(true);
    expect(typeof result.committed_workflow_id).toBe("string");
  });
});
