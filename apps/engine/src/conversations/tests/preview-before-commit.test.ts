// Preview-before-commit gate — commit_draft refuses without a successful
// dry-run on record, unless the caller supplies force=true (which writes
// the WORKFLOW_COMMITTED_OVERRIDE audit row).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversationElicitations, conversations } from "../../db/schema/index.ts";
import { commitDraftTool } from "../tools/commit-draft.ts";
import type { ToolContext } from "../tools/index.ts";
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
    input: { kind: "commit_draft", summary: "commit" },
    output: { confirmed: true },
    status: "resolved",
  });
}

describe("commit_draft preview-before-commit gate", () => {
  test("refuses commit when no successful preview is recorded", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { name: "no-preview", steps: [] },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft: DraftDocument = {
      name: "no-preview",
      slug: "no-preview",
      steps: [{ id: "s1", kind: "transform", expression: "$input.n", language: "jsonata" }],
      // No latest_preview — gate must refuse.
    };
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error?: unknown; reason?: unknown };
    expect(data.error).toBe("preview_required");
    expect(data.reason).toBe("no_successful_preview");
  });

  test("commits with force=true and writes a WORKFLOW_COMMITTED_OVERRIDE audit row", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { name: "forced", steps: [] },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft: DraftDocument = {
      name: "forced-commit",
      slug: `forced-${Date.now()}`,
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://example.invalid/health",
        },
      ],
    };
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      { force: true },
    );
    expect(result.ok).toBe(true);
    expect(typeof result.committed_workflow_id).toBe("string");

    const rows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "workflow.committed_override"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last?.resource_id).toBe(result.committed_workflow_id ?? "");
    const meta = last?.metadata as { conversation_id?: string; latest_preview_ok?: unknown };
    expect(meta.conversation_id).toBe(conv.id);
    expect(meta.latest_preview_ok).toBeNull();
  });

  test("commits without force when the draft carries a successful preview", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { name: "previewed", steps: [] },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    const draft: DraftDocument = {
      name: "previewed-commit",
      slug: `previewed-${Date.now()}`,
      steps: [{ id: "t1", kind: "transform", expression: "$input.n", language: "jsonata" }],
      latest_preview: {
        ok: true,
        step_id: "t1",
        summary: "Previewed t1 in 1ms.",
      },
    };
    const result = await commitDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => draft),
      {},
    );
    expect(result.ok).toBe(true);
    expect(typeof result.committed_workflow_id).toBe("string");
  });
});
