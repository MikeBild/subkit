import { afterAll, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

export let ctx: ConversationTestCtx;

export function readyDraft(slug: string, name = slug): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name,
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
  };
  let draft = withWorkflowInspection(base);
  draft = withWorkflowValidation(draft, true, "Workflow draft validated.");
  draft = withLatestPreview(draft, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
  return draft;
}

export async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

export async function seedApprovedConfirm(conversationId: string): Promise<void> {
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

export function stubToolCtx(conversationId: string, draft: DraftDocument): ToolContext {
  let live = draft;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
      await ctx.testDb.db
        .update(conversations)
        .set({ draft: next })
        .where(
          and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversationId)),
        );
    },
  };
}

export function useCommitWorkflowGatesSetup(): void {
  beforeAll(async () => {
    ctx = await createConversationTestCtx("commit_gates");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });
}
