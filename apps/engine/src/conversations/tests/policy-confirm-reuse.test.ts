import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  toolApprovals,
} from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { openedElicitation } from "../../test-helpers/elicitations.ts";
import { requestApproval } from "../../tools/approval.ts";
import {
  createElicitation,
  expireElicitationAndReactivate,
  resolveElicitation,
} from "../elicitations.ts";
import { saveVerificationEvidence } from "../handoff-summary.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;
let principal: ResolvedPrincipal;
const nextUuid = createDeterministicUuidFactory(635);

beforeAll(async () => {
  ctx = await createConversationTestCtx("policy-confirm-reuse");
  principal = {
    provider: "test",
    kind: "user",
    id: ctx.user_id,
    tenant_id: ctx.tenant_id,
    roles: ["admin"],
  } as ResolvedPrincipal;
});

afterAll(async () => {
  await ctx.cleanup();
});

const SAVE_ARGS = { force_commit: false, confirmed: false };

const seedConversation = async () => {
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, owner_id: ctx.user_id, status: "active" })
    .returning();
  if (!conversation) throw new Error("failed to seed conversation");
  return conversation.id;
};

const mintApproval = async (tool: string, args: Record<string, unknown>) => {
  const approvalId = nextUuid();
  await requestApproval({
    db: ctx.testDb.db,
    principal,
    approval_id: approvalId,
    tool,
    surface: "chat",
    via: "chat",
    reason: "category_default",
    execution_mode: null,
    args,
  });
  return approvalId;
};

const draftEvidence = (name: string) =>
  saveVerificationEvidence({ workflow: { name } } as DraftDocument, true);

const saveGateInput = (
  approvalId: string | null,
  draftName = "orders",
  args: Record<string, unknown> = SAVE_ARGS,
) => ({
  kind: "save_workflow_draft",
  question: "Policy requires confirmation before running save_workflow_draft. Proceed?",
  target: { tool: "save_workflow_draft", args },
  verification: draftEvidence(draftName),
  pending_output: { kind: "save_workflow_draft" },
  commit_intent: {
    kind: "save_workflow_draft",
    payload: {
      ...(args.force_commit === true ? { force_commit: true } : {}),
      ...(approvalId ? { approval_id: approvalId } : {}),
    },
    description: "Save the current workflow draft.",
  },
  ...(approvalId ? { approval_url: `https://engine.example.test/approve/${approvalId}` } : {}),
});

const ask = async (
  conversationId: string,
  summary: string,
  input: Record<string, unknown>,
  reuse = true,
  toolCallId: string | null = null,
) =>
  openedElicitation(
    await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        tool_call_id: toolCallId,
        tool_name: "ask_user_confirm",
        summary,
        input,
        actor_id: ctx.user_id,
        ...(reuse ? { reuse_open_approval: true } : {}),
      },
      ctx.testDb.db,
    ),
  );

const pendingIds = async (conversationId: string) => {
  const rows = await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, conversationId));
  return rows.filter((row) => row.status === "pending").map((row) => row.id);
};

const askTwiceForSave = async (
  firstInput: (handle: string) => Record<string, unknown>,
  secondInput: (handle: string) => Record<string, unknown>,
  firstArgs: Record<string, unknown> = SAVE_ARGS,
  secondArgs: Record<string, unknown> = SAVE_ARGS,
) => {
  const conversationId = await seedConversation();
  const firstHandle = await mintApproval("save_workflow_draft", firstArgs);
  const first = await ask(conversationId, "Save inactive draft", firstInput(firstHandle));
  const secondHandle = await mintApproval("save_workflow_draft", secondArgs);
  const second = await ask(conversationId, "Save inactive draft", secondInput(secondHandle));
  return { conversationId, first, second, firstHandle, secondHandle };
};

test("a repeated save gate for the same draft keeps the open card and its handle", async () => {
  const { conversationId, first, second, firstHandle } = await askTwiceForSave(
    (handle) => saveGateInput(handle),
    (handle) => saveGateInput(handle),
  );
  expect(second.id).toBe(first.id);
  expect(second.input).toEqual(first.input);
  expect((second.input as { approval_url?: string }).approval_url).toContain(firstHandle);
  expect(await pendingIds(conversationId)).toEqual([first.id]);
});

test("a reused card keeps its persisted summary and input instead of the new request's", async () => {
  const conversationId = await seedConversation();
  const agentCard = {
    kind: "save_workflow_draft",
    question: "Commit this 2-step workflow?",
    verification: draftEvidence("orders"),
    commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
  };
  const first = await ask(conversationId, "commit 2-step workflow", agentCard, false);
  const handle = await mintApproval("save_workflow_draft", SAVE_ARGS);
  const second = await ask(conversationId, "Save inactive draft", saveGateInput(handle));
  expect(second.id).toBe(first.id);
  expect(second.summary).toBe("commit 2-step workflow");
  expect(second.input).toEqual(first.input);
  expect(JSON.stringify(second.input)).not.toContain(handle);
  expect(await pendingIds(conversationId)).toEqual([first.id]);
});

test("an expired but still pending save card is superseded by a fresh card", async () => {
  const conversationId = await seedConversation();
  const first = await ask(
    conversationId,
    "Save inactive draft",
    saveGateInput(await mintApproval("save_workflow_draft", SAVE_ARGS)),
  );
  await ctx.testDb.db
    .update(conversationElicitations)
    .set({ expires_at: new Date(getTestNow() - 60_000) })
    .where(eq(conversationElicitations.id, first.id));
  const second = await ask(
    conversationId,
    "Save inactive draft",
    saveGateInput(await mintApproval("save_workflow_draft", SAVE_ARGS)),
  );
  expect(second.id).not.toBe(first.id);
  expect(await pendingIds(conversationId)).toEqual([second.id]);
});

test("a changed draft or changed save arguments get a fresh card", async () => {
  const changedDraft = await askTwiceForSave(
    (handle) => saveGateInput(handle, "orders"),
    (handle) => saveGateInput(handle, "invoices"),
  );
  expect(changedDraft.second.id).not.toBe(changedDraft.first.id);
  expect(await pendingIds(changedDraft.conversationId)).toEqual([changedDraft.second.id]);
  const forced = { force_commit: true, confirmed: false };
  const changedArgs = await askTwiceForSave(
    (handle) => saveGateInput(handle),
    (handle) => saveGateInput(handle, "orders", forced),
    SAVE_ARGS,
    forced,
  );
  expect(changedArgs.second.id).not.toBe(changedArgs.first.id);
  expect(await pendingIds(changedArgs.conversationId)).toEqual([changedArgs.second.id]);
});

test("a card whose handle no longer covers the request is superseded", async () => {
  const conversationId = await seedConversation();
  const firstHandle = await mintApproval("save_workflow_draft", SAVE_ARGS);
  const first = await ask(conversationId, "Save inactive draft", saveGateInput(firstHandle));
  await ctx.testDb.db
    .update(toolApprovals)
    .set({ declined_at: new Date(getTestNow()) })
    .where(eq(toolApprovals.id, firstHandle));
  const second = await ask(
    conversationId,
    "Save inactive draft",
    saveGateInput(await mintApproval("save_workflow_draft", SAVE_ARGS)),
  );
  expect(second.id).not.toBe(first.id);
  expect(await pendingIds(conversationId)).toEqual([second.id]);
  const otherArgs = await askTwiceForSave(
    (handle) => saveGateInput(handle),
    (handle) => saveGateInput(handle),
    SAVE_ARGS,
    { ...SAVE_ARGS, target_workflow_id: "wf-other" },
  );
  expect(otherArgs.second.id).not.toBe(otherArgs.first.id);
});

test("repeated external MCP calls never reuse a card, even with identical arguments", async () => {
  const mcpInput = (handle: string, args: Record<string, unknown>) => ({
    kind: "external_write",
    question: "Run mcp__crm__update_contact?",
    target: { tool: "mcp__crm__update_contact", args },
    commit_intent: {
      kind: "execute_confirmed_tool_call",
      payload: { tool: "mcp__crm__update_contact", approval_id: handle },
    },
  });
  for (const [firstArgs, secondArgs] of [
    [{ id: "1" }, { id: "2" }],
    [{ id: "1" }, { id: "1" }],
  ] as const) {
    for (const reuse of [true, false]) {
      const conversationId = await seedConversation();
      const firstHandle = await mintApproval("mcp__crm__update_contact", firstArgs);
      const first = await ask(
        conversationId,
        "Update contact",
        mcpInput(firstHandle, firstArgs),
        reuse,
      );
      const secondHandle = await mintApproval("mcp__crm__update_contact", secondArgs);
      const second = await ask(
        conversationId,
        "Update contact",
        mcpInput(secondHandle, secondArgs),
        reuse,
      );
      expect(second.id).not.toBe(first.id);
      expect(JSON.stringify(second.input)).toContain(secondHandle);
      expect(await pendingIds(conversationId)).toEqual([second.id]);
    }
  }
});

test("an ask-user save card never reuses the open card", async () => {
  const conversationId = await seedConversation();
  const card = {
    kind: "save_workflow_draft",
    question: "Commit this workflow?",
    verification: draftEvidence("orders"),
    commit_intent: { kind: "save_workflow_draft", payload: {} },
  };
  const first = await ask(conversationId, "commit workflow", card, false);
  const second = await ask(conversationId, "commit workflow", card, false);
  expect(second.id).not.toBe(first.id);
  expect(await pendingIds(conversationId)).toEqual([second.id]);
});

for (const decision of ["approved", "declined", "expired", "superseded"] as const) {
  test(`all calls attached to a reused save card settle when ${decision}`, async () => {
    const conversationId = await seedConversation();
    const calls = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values(
        Array.from({ length: 3 }, () => ({
          tenant_id: ctx.tenant_id,
          conversation_id: conversationId,
          tool: "save_workflow_draft",
          input: SAVE_ARGS,
          outcome: "pending" as const,
        })),
      )
      .returning();
    const cards = [];
    for (const call of calls) {
      const card = await ask(
        conversationId,
        "Save inactive draft",
        saveGateInput(null),
        true,
        call.id,
      );
      cards.push(card);
      await ctx.testDb.db
        .update(conversationToolCalls)
        .set({
          output: { pending: true, status: "awaiting_confirmation", elicitation_id: card.id },
        })
        .where(eq(conversationToolCalls.id, call.id));
    }
    expect(new Set(cards.map((card) => card.id)).size).toBe(1);
    const id = cards[0]!.id;
    if (decision === "superseded") {
      const replacement = await ask(
        conversationId,
        "Save changed draft",
        saveGateInput(null, "invoices"),
      );
      expect(replacement.id).not.toBe(id);
      const settled = await ctx.testDb.db
        .select()
        .from(conversationToolCalls)
        .where(eq(conversationToolCalls.conversation_id, conversationId));
      for (const call of settled) {
        expect(call.output).toEqual({
          ok: false,
          abandoned: true,
          reason: "elicitation_superseded",
        });
      }
      return;
    }
    if (decision === "expired") {
      await expireElicitationAndReactivate(
        { tenant_id: ctx.tenant_id, conversation_id: conversationId, id },
        ctx.testDb.db,
      );
    } else {
      await resolveElicitation(
        {
          tenant_id: ctx.tenant_id,
          id,
          output: { confirmed: decision === "approved" },
          decided_by: null,
        },
        ctx.testDb.db,
      );
    }
    const settled = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversationId));
    expect(settled.map((call) => call.outcome)).toEqual(
      calls.map(() =>
        decision === "expired" ? "expired" : decision === "approved" ? "ok" : "denied",
      ),
    );
    if (decision === "expired") {
      for (const call of settled) expect(call.confirmation_state).toBe("expired");
    }
  });
}
