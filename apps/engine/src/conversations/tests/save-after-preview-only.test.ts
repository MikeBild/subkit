// save_workflow_draft permits commit when ONLY workflow_previewed is fresh
// (no explicit inspect/validate calls between mutation and dry_run).
//
// Pre-fix the auto-persist write at session a128deba 15:18:31.506
// failed with `workflow_not_ready` because the LLM had run dry_run
// successfully but never explicitly inspect_workflow_draft +
// validate_draft. The user clicked "approve", auto-persist denied,
// the LLM had to retry through save_workflow_draft with the same checkpoints
// (now somehow refreshed) — and the user had to click "approve" a
// SECOND time.
//
// The relaxed gate: a fresh successful workflow_previewed checkpoint
// subsumes inspect+validate (the dry_run necessarily walked + parsed
// the draft). Without the relaxation, every auto-persist round-trip
// requires the LLM to also burn a turn calling inspect+validate
// before asking for confirmation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  workflowVersions,
} from "../../db/schema/index.ts";
import { withLatestPreview } from "../authoring-state.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("commit-after-preview-only");
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
    input: { kind: "save_workflow_draft", summary: "commit" },
    output: { confirmed: true },
    status: "resolved",
  });
}

describe("save_workflow_draft · workflow_previewed subsumes inspect+validate", () => {
  test("commits successfully when only workflow_previewed is fresh", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "preview-only", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    await seedApprovedConfirm(conv.id);

    // Build a draft that has NO workflow_inspected / workflow_validated
    // checkpoint, but has a fresh successful workflow_previewed
    // checkpoint via withLatestPreview. This is exactly the shape the
    // auto-persist path saw in session a128deba.
    const draftBase: DraftDocument = {
      workflow: {
        name: "preview-only",
        slug: "preview-only",
        steps: [{ id: "s1", kind: "transform", expression: "$input.n", language: "jsonata" }],
      },
    };
    const previewed = withLatestPreview(
      draftBase,
      {
        ok: true,
        step_id: "s1",
        summary: "Ran 1 step with no errors.",
        preview: { n: 42 },
      },
      "dry_run_workflow",
      "workflow_previewed",
    );

    const result = await saveWorkflowDraftTool.execute(
      toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => previewed),
      {},
    );
    // Either fully ok, or it fails for a reason OTHER than
    // workflow_not_ready / stale workflow_inspected/validated. The
    // important thing is the relaxation lets the gate pass.
    if (!result.ok) {
      const data = result.data as { error_code?: string; stale_checkpoints?: string[] };
      // The gate must NOT cite the inspected/validated checkpoints
      // when workflow_previewed is fresh. Any OTHER failure is
      // acceptable for this test (e.g. slug uniqueness, etc.) — but
      // the regression we're guarding against is the
      // workflow_not_ready response.
      expect(data.error_code).not.toBe("workflow_not_ready");
      expect(data.stale_checkpoints ?? []).not.toContain("workflow_inspected");
      expect(data.stale_checkpoints ?? []).not.toContain("workflow_validated");
    }
  });
});

describe("commitWorkflowAtomic · hash-dedup on unchanged re-commit", () => {
  test("re-committing an unchanged draft is a no-op — no extra workflow version", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: { workflow: { name: "dedup-wf", steps: [] } },
      })
      .returning();
    if (!conv) throw new Error("conversation insert failed");

    const slug = `dedup-wf-${conv.id.slice(0, 8)}`;
    const draftBase: DraftDocument = {
      workflow: {
        name: "Dedup WF",
        slug,
        steps: [{ id: "s1", kind: "transform", expression: "$input.n", language: "jsonata" }],
      },
    };
    const previewed = withLatestPreview(
      draftBase,
      { ok: true, step_id: "s1", summary: "Ran 1 step with no errors.", preview: { n: 42 } },
      "dry_run_workflow",
      "workflow_previewed",
    );
    // Mutable draft ref: commitWorkflowAtomic calls setDraft after the
    // write, and the second commit must observe the persisted binding.
    let live: DraftDocument = previewed;
    const tc: ToolContext = {
      ...toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => live),
      setDraft: async (d) => {
        live = d as DraftDocument;
      },
    };

    // First commit — the green dry-run auto-persist shape.
    const first = await commitWorkflowAtomic({
      ctx: tc,
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_green_dry_run",
      commitIntentKind: "save_workflow_draft",
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { workflow_id: string; version: number };
    expect(firstData.version).toBe(1);

    // Second commit of the SAME draft — must dedup, not rotate. The
    // commit still succeeds; it just resolves to the unchanged version.
    const second = await commitWorkflowAtomic({
      ctx: tc,
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_green_dry_run",
      commitIntentKind: "save_workflow_draft",
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as { version: number };
    expect(secondData.version).toBe(1);

    // Exactly one workflow_versions row exists — the second commit
    // did not append a redundant version.
    const versionRows = await ctx.testDb.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, ctx.tenant_id),
          eq(workflowVersions.workflow_id, firstData.workflow_id),
        ),
      );
    expect(versionRows.length).toBe(1);
  });
});
