import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("draft_compare_and_swap");
});

afterAll(async () => {
  await ctx.cleanup();
});

function readyDraft(slug: string, expression: string): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [{ id: "echo", kind: "transform", expression, language: "javascript" }],
    },
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  return withLatestPreview(draft, { ok: true, summary: "preview ok", warnings: [] });
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
      await appendSnapshot(ctx.tenant_id, conversationId, next, ctx.testDb.db);
    },
  };
}

async function observedEdit(
  conversationId: string,
  slug: string,
  expression: string,
): Promise<DraftDocument> {
  const observed = await loadDraft(ctx.tenant_id, conversationId, ctx.testDb.db);
  const draft = readyDraft(slug, expression);
  if (!draft.state) throw new Error("ready draft state missing");
  draft.state.persisted_resources = observed.state?.persisted_resources ?? [];
  return draft;
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: row.id,
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
  return row.id;
}

async function draftVersionOf(workflowId: string): Promise<string | null> {
  const [row] = await ctx.testDb.db
    .select({ draft_version_id: workflows.draft_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflowId)))
    .limit(1);
  return row?.draft_version_id ?? null;
}

describe("save_workflow_draft · expected draft version", () => {
  test("a new workflow saves only when the caller expects no saved draft", async () => {
    const conversationId = await freshConversation();
    const stale = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("cas-new", "return 1;")),
      expected_draft_version_id: "00000000-0000-4000-8000-000000000001",
    });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.error_code).toBe("draft_conflict");

    const saved = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("cas-new", "return 1;")),
      expected_draft_version_id: null,
    });
    expect(saved.ok).toBe(true);
  });

  test("a stale expected version is refused and writes nothing; the current one saves", async () => {
    const conversationId = await freshConversation();
    const first = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, readyDraft("cas-edit", "return 1;")),
    });
    expect(first.ok).toBe(true);
    const { workflow_id: workflowId, workflow_version_id: v1 } = first.data as {
      workflow_id: string;
      workflow_version_id: string;
    };
    expect(await draftVersionOf(workflowId)).toBe(v1);

    const second = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, "cas-edit", "return 2;")),
      expected_draft_version_id: v1,
    });
    expect(second.ok).toBe(true);
    const v2 = (second.data as { workflow_version_id: string }).workflow_version_id;
    expect(v2).not.toBe(v1);

    const stale = await commitWorkflowAtomic({
      ctx: stubToolCtx(conversationId, await observedEdit(conversationId, "cas-edit", "return 3;")),
      expected_draft_version_id: v1,
    });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.error_code).toBe("draft_conflict");
    const extra = stale.data as Record<string, unknown>;
    expect(extra.expected_draft_version_id).toBe(v1);
    expect(extra.observed_draft_version_id).toBe(v2);
    expect(extra.local_changes_preserved).toBe(true);
    expect(await draftVersionOf(workflowId)).toBe(v2);
  });
});
