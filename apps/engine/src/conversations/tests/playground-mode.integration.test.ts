import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { conversations, workflows } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import { loadDraft } from "../draft.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import { createConversation } from "../service/create.ts";
import { filterByAuthoringPalette, WORKFLOW_AUTHORING_SKILL } from "../tools/authoring-palette.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("playground");
});

afterAll(async () => {
  await ctx.cleanup();
});

function committableDraft(slug: string, session?: DraftDocument["session"]): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "return input.input;",
          language: "javascript",
        },
      ],
    },
    ...(session ? { session } : {}),
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "validated");
  draft = withLatestPreview(draft, { ok: true, summary: "preview ok", warnings: [] });
  return draft;
}

function stubToolCtx(conversationId: string, draft: DraftDocument): ToolContext {
  let live = draft;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal engineClient stub
    engineClient: {} as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
    },
  };
}

describe("D5 — playground conversation creation", () => {
  test("preloads workflow-authoring, flags the draft durably, and binds no workflow", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        workflow_id: "00000000-0000-4000-8000-000000000094",
        initial_message: "let me experiment with a workflow",
        playground: true,
      },
      ctx.testDb.db,
    );

    const [row] = await ctx.testDb.db
      .select({
        loaded_skills: conversations.loaded_skills,
        target_workflow_id: conversations.target_workflow_id,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenant_id, ctx.tenant_id),
          eq(conversations.id, created.conversation.id),
        ),
      )
      .limit(1);

    expect(row?.loaded_skills.map((s) => s.slug)).toContain(WORKFLOW_AUTHORING_SKILL);
    expect(row?.target_workflow_id).toBeNull();

    const draft = await loadDraft(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(draft.session?.playground).toBe(true);
  });
});

describe("D5 — playground palette", () => {
  test("workflow-authoring preload exposes the author/dry-run/edit triad", () => {
    const tools = [
      { name: "author_workflow", category: "draft_write" as const },
      { name: "edit_workflow_patch", category: "draft_write" as const },
      { name: "dry_run_workflow", category: "tenant_read" as const },
      { name: "save_workflow_draft", category: "draft_write" as const },
    ];
    const visible = filterByAuthoringPalette(
      tools,
      committableDraft("scratch"),
      new Set([WORKFLOW_AUTHORING_SKILL]),
    ).map((t) => t.name);
    expect(visible).toContain("author_workflow");
    expect(visible).toContain("dry_run_workflow");
    expect(visible).toContain("edit_workflow_patch");
  });
});

describe("D5 — playground commit persists nothing", () => {
  test("commitWorkflowAtomic short-circuits with playground_no_persist and writes no workflow row", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    if (!conv) throw new Error("seed conversation failed");

    const slug = "playground-scratch-wf";
    const draft = committableDraft(slug, { playground: true });
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conv.id, draft),
      skipPriorApprovalCheck: true,
      emitAutoPersistAudit: true,
      reason: "auto_persist_on_confirmation",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected playground commit to be blocked");
    expect(result.error_code).toBe("playground_no_persist");

    const rows = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, slug),
          isNull(workflows.deleted_at),
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("a NON-playground draft with the same shape DOES persist (control)", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    if (!conv) throw new Error("seed conversation failed");

    const slug = "normal-persisted-wf";
    const result = await commitWorkflowAtomic({
      ctx: stubToolCtx(conv.id, committableDraft(slug)),
      skipPriorApprovalCheck: true,
    });
    expect(result.ok).toBe(true);

    const rows = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, slug),
          isNull(workflows.deleted_at),
        ),
      );
    expect(rows.length).toBe(1);
  });
});
