import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  workflowVersions,
} from "../../db/schema/index.ts";
import { withLatestPreview } from "../authoring-state/index.ts";
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
    input: {
      kind: "save_workflow_draft",
      summary: "commit",
      commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
    },
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

    const draftBase: DraftDocument = {
      workflow: {
        name: "preview-only",
        slug: "preview-only",
        steps: [
          {
            id: "s1",
            kind: "transform",
            language: "javascript",
            expression: "return input.input.n;",
          },
        ],
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
    if (!result.ok) {
      const data = result.data as { error_code?: string; stale_checkpoints?: string[] };
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
        steps: [
          {
            id: "s1",
            kind: "transform",
            language: "javascript",
            expression: "return input.input.n;",
          },
        ],
      },
    };
    const previewed = withLatestPreview(
      draftBase,
      { ok: true, step_id: "s1", summary: "Ran 1 step with no errors.", preview: { n: 42 } },
      "dry_run_workflow",
      "workflow_previewed",
    );
    let live: DraftDocument = previewed;
    const tc: ToolContext = {
      ...toolCtx(ctx.tenant_id, conv.id, ctx.user_id, () => live),
      setDraft: async (d) => {
        live = d as DraftDocument;
      },
    };

    const first = await commitWorkflowAtomic({
      ctx: tc,
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_green_dry_run",
      commitIntentKind: "save_workflow_draft",
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as {
      workflow_id: string;
      version: number;
      version_changed?: boolean;
    };
    expect(firstData.version).toBe(1);
    expect(firstData.version_changed).toBe(true);
    expect(first.committed_workflow_id).toBe(firstData.workflow_id);

    const second = await commitWorkflowAtomic({
      ctx: tc,
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_green_dry_run",
      commitIntentKind: "save_workflow_draft",
    });
    expect(second.ok).toBe(true);
    const secondData = second.data as {
      already_persisted?: boolean;
      version: number;
      version_changed?: boolean;
      workflow_id: string;
    };
    expect(secondData.already_persisted).toBe(true);
    expect(secondData.version).toBe(1);
    expect(secondData.version_changed).toBe(false);
    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(second.committed_workflow_id).toBeUndefined();

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

    await seedApprovedConfirm(conv.id);
    const toolResult = await saveWorkflowDraftTool.execute(tc, {});
    expect(toolResult.ok).toBe(true);
    const toolData = toolResult.data as {
      already_persisted?: boolean;
      version_changed?: boolean;
      workflow_id: string;
    };
    expect(toolData.already_persisted).toBe(true);
    expect(toolData.version_changed).toBe(false);
    expect(toolData.workflow_id).toBe(firstData.workflow_id);
    expect(toolResult.committed_workflow_id).toBeUndefined();
  });
});
