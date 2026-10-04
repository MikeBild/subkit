import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversationElicitations, conversations } from "../../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import {
  findPriorSaveWorkflowApproval,
  rowAuthorizesSaveWorkflow,
} from "../save-workflow-approval.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("save-workflow-approval");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("failed to seed conversation");
  return row.id;
}

describe("rowAuthorizesSaveWorkflow — pure predicate", () => {
  test("authorizes a generic-kind confirm carrying commit_intent.kind=save_workflow_draft", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "resolved",
        input: {
          kind: "generic",
          commit_intent: { kind: "save_workflow_draft", payload: {}, description: "save" },
        },
        output: { confirmed: true },
      }),
    ).toBe(true);
  });

  test("authorizes a save_workflow_draft-kind confirm carrying the same commit_intent", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "resolved",
        input: {
          kind: "save_workflow_draft",
          commit_intent: { kind: "save_workflow_draft", payload: {}, description: "save" },
        },
        output: { confirmed: true },
      }),
    ).toBe(true);
  });

  test("rejects an external_write confirm with NO save-workflow commit_intent", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "resolved",
        input: { kind: "external_write" },
        output: { confirmed: true },
      }),
    ).toBe(false);
  });

  test("rejects a confirm whose commit_intent is for a different kind", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "resolved",
        input: {
          kind: "generic",
          commit_intent: { kind: "delete_workflow", payload: {}, description: "delete" },
        },
        output: { confirmed: true },
      }),
    ).toBe(false);
  });

  test("rejects an unresolved (pending) row", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "pending",
        input: {
          kind: "generic",
          commit_intent: { kind: "save_workflow_draft", payload: {}, description: "save" },
        },
        output: null,
      }),
    ).toBe(false);
  });

  test("rejects a resolved row where the operator did not confirm", () => {
    expect(
      rowAuthorizesSaveWorkflow({
        status: "resolved",
        input: {
          kind: "generic",
          commit_intent: { kind: "save_workflow_draft", payload: {}, description: "save" },
        },
        output: { confirmed: false },
      }),
    ).toBe(false);
  });
});

describe("findPriorSaveWorkflowApproval — production multi-turn scenario", () => {
  test("the exact stuck-conversation rows resolve to an authorizing approval", async () => {
    const conversation_id = await freshConversation();
    const base = new Date("2026-05-22T12:00:00.000Z").getTime();
    let seq = 0;
    const seed = async (
      input: Record<string, unknown>,
      status: "resolved" | "cancelled",
      output: Record<string, unknown> | null,
    ) => {
      await ctx.testDb.db.insert(conversationElicitations).values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "seeded",
        input,
        ...(output ? { output } : {}),
        status,
        created_at: new Date(base + seq++ * 1000),
      });
    };
    await seed({ kind: "external_write" }, "resolved", { confirmed: true });
    await seed({ kind: "external_write" }, "cancelled", null);
    await seed({ kind: "review_after_execution" }, "resolved", { confirmed: true });
    await seed(
      {
        kind: "generic",
        commit_intent: { kind: "save_workflow_draft", payload: {}, description: "Save the draft." },
      },
      "resolved",
      { confirmed: true },
    );

    const approval = await findPriorSaveWorkflowApproval(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
    );
    expect(approval).not.toBeNull();
    expect(approval?.status).toBe("resolved");
  });

  test("a conversation with only external_write confirms yields no approval", async () => {
    const conversation_id = await freshConversation();
    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "external write",
      input: { kind: "external_write", target: { tool: "call_connector" } },
      output: { confirmed: true },
      status: "resolved",
    });
    const approval = await findPriorSaveWorkflowApproval(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
    );
    expect(approval).toBeNull();
  });
});
