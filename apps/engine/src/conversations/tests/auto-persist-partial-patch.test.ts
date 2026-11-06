import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist_partial_patch");
  tenant_id = (await seedTenant(ctx.db, { slug: "t-app", display_name: "T-APP" })).id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeDraft(): DraftDocument {
  return {
    workflow: {
      name: "partial-flow",
      slug: "partial-flow",
      steps: [
        { id: "a", kind: "transform", language: "javascript", expression: "return input.input;" },
        { id: "b", kind: "transform", language: "javascript", expression: "return input.input;" },
      ],
    },
    latest_preview: {
      ok: true,
      summary: "seeded",
      step_traces: [
        { step_id: "a", kind: "transform", status: "succeeded", output_preview: { v: 1 } },
        { step_id: "b", kind: "transform", status: "succeeded", output_preview: { v: 1 } },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

const PATCHES = [
  { op: "replace", path: "/steps/0/expression", value: "return { a: input.input };" },
  { op: "replace", path: "/steps/1/expression", value: "return { b: input.input };" },
];

async function seedConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  await appendSnapshot(tenant_id, conv!.id, makeDraft(), ctx.db);
  return conv!.id;
}

async function carrier(
  conversation_id: string,
): Promise<{ id: string; tool_name: string; input: unknown }> {
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "Review 2 edits",
      input: {
        question: "Keep these edits?",
        kind: "partial_diff_approval",
        commit_intent: {
          kind: "apply_workflow_patch",
          payload: { patches: PATCHES },
          description: "Apply 2 workflow edits.",
        },
      },
      output: {},
      status: "resolved",
    })
    .returning();
  if (!row) throw new Error("elicitation insert failed");
  return { id: row.id, tool_name: row.tool_name, input: row.input };
}

function steps(draft: DraftDocument): Array<{ id: string; expression?: string }> {
  return draft.workflow.steps as Array<{ id: string; expression?: string }>;
}

describe("auto-persist — apply_workflow_patch (D3)", () => {
  test("accept-all: both ops applied when no explicit selection", async () => {
    const conversation_id = await seedConversation();
    const elicitation = await carrier(conversation_id);
    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("edit_workflow_patch");
    const data = dispatch.synthetic_result?.data as {
      partial: boolean;
      applied_count: number;
      skipped_count: number;
    };
    expect(data.applied_count).toBe(2);
    expect(data.skipped_count).toBe(0);
    expect(data.partial).toBe(false);

    const after = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(steps(after!)[0]!.expression).toBe("return { a: input.input };");
    expect(steps(after!)[1]!.expression).toBe("return { b: input.input };");
  });

  test("partial: only the accepted op is applied; skipped op reported", async () => {
    const conversation_id = await seedConversation();
    const elicitation = await carrier(conversation_id);
    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true, partial: true, approved_indices: [1] },
      elicitation,
      db: ctx.db,
    });
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    const data = dispatch.synthetic_result?.data as {
      partial: boolean;
      applied_count: number;
      skipped_count: number;
      skipped_ops: Array<{ label: string }>;
    };
    expect(data.applied_count).toBe(1);
    expect(data.skipped_count).toBe(1);
    expect(data.partial).toBe(true);
    expect(data.skipped_ops[0]!.label).toContain("/steps/0/expression");

    const after = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(steps(after!)[0]!.expression).toBe("return input.input;");
    expect(steps(after!)[1]!.expression).toBe("return { b: input.input };");
  });

  test("decline: nothing applied, draft byte-stable", async () => {
    const conversation_id = await seedConversation();
    const before = await loadDraft(tenant_id, conversation_id, ctx.db);
    const elicitation = await carrier(conversation_id);
    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: false },
      elicitation,
      db: ctx.db,
    });
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("user_declined");

    const after = await loadDraft(tenant_id, conversation_id, ctx.db);
    expect(steps(after!)[0]!.expression).toBe("return input.input;");
    expect(steps(after!)[1]!.expression).toBe("return input.input;");
    expect(JSON.stringify(after!.workflow)).toBe(JSON.stringify(before!.workflow));
  });
});
