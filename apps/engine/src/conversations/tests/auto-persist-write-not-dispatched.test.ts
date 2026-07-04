// Auto-persist honest-failure path (RC3 — "reported ≠ written").
//
// An `ask_user_confirm` whose `kind` declares a WRITE (external_write /
// save_workflow_draft) that the operator APPROVED, yet carries no
// commit_intent the harness can dispatch, must NOT silently no-op.
// Pre-fix the harness wrote nothing and gave the LLM no signal, so it
// narrated success it never achieved (render-upload-slides: a
// description edit the model mis-tagged `kind:external_write` after
// drifting). Now the dispatcher injects a synthetic
// `error_code:"write_not_dispatched"` so the next turn must recover.
//
// Plain `generic` confirms and declined/ambiguous answers keep the
// silent skip — only an approved write-shaped confirm is a write the
// operator expected to land.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist_wnd");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-apw", display_name: "T-APW" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  return conv!.id;
}

async function insertConfirm(p: {
  conversation_id: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: p.conversation_id,
      tool_name: "ask_user_confirm",
      summary: "test carrier",
      input: p.input,
      output: p.output,
      status: "resolved",
    })
    .returning();
  return { id: row!.id, tool_name: row!.tool_name, input: row!.input };
}

describe("auto-persist — write_not_dispatched honest failure", () => {
  test("approved external_write confirm with NO commit_intent → synthetic write_not_dispatched", async () => {
    const conversation_id = await seedConversation();
    const elicitation = await insertConfirm({
      conversation_id,
      input: { question: "Confirm update_workflow", kind: "external_write" },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("write_not_dispatched");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    // The signal reached the conversation timeline so the next turn sees it.
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    const out = calls[0]!.output as Record<string, unknown>;
    expect(out.error_code).toBe("write_not_dispatched");
    expect(out.source).toBe("harness_auto_persist");
  });

  test("approved save_workflow_draft-kind confirm with NO commit_intent → write_not_dispatched", async () => {
    const conversation_id = await seedConversation();
    // Portal spelling `{approved:true}` must read as confirmed too.
    const elicitation = await insertConfirm({
      conversation_id,
      input: { question: "Commit the workflow?", kind: "save_workflow_draft" },
      output: { approved: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { approved: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.error_code).toBe("write_not_dispatched");
  });

  test("approved generic confirm with no commit_intent → silent skip (dispatched:false)", async () => {
    const conversation_id = await seedConversation();
    const elicitation = await insertConfirm({
      conversation_id,
      input: { question: "Proceed?", kind: "generic" },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(false);
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(0);
  });

  test("DECLINED external_write confirm with no commit_intent → silent skip (dispatched:false)", async () => {
    const conversation_id = await seedConversation();
    const elicitation = await insertConfirm({
      conversation_id,
      input: { question: "Confirm update_workflow", kind: "external_write" },
      output: { confirmed: false },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: false },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(false);
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(0);
  });
});
