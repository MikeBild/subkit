// markApprovalElicitationsComplete — the portal→conversation reactivation link.
//
// The approval portal (`/v1/tool-approvals/decide`) grants a `tool_approvals`
// row but knows nothing about the paused conversation. This function is the
// bridge: it matches the pending confirm elicitation by the `approval_id` its
// `commit_intent` carries AND the presence of an `approval_url`, marks it
// `url_completed` / `url_failed`, so the polling MCP client's next Tasks poll
// replays the decision and resumes the turn.
//
// These tests pin the match precision — the query must touch ONLY the row that
// took the approval-portal path, never a shape-carrier row, an OAuth/credential
// URL row, or a different approval's row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { markApprovalElicitationsComplete } from "../native-url-elicitation.ts";

let ctx: TestDb;
let tenant_id: string;

/** Deterministic UUIDs — random ids are banned in tests (determinism gate). */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeAll(async () => {
  ctx = await createTestDb("mark_approval_elicitations_complete");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-maec", display_name: "T-MAEC" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function freshConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  return conv!.id;
}

/** Seed a pending `ask_user_confirm` row. `approvalId` lands on the
 *  `commit_intent`; `approvalUrl`, when given, marks it as having taken the
 *  portal path. */
async function seedConfirm(p: {
  conversation_id: string;
  approvalId: string;
  approvalUrl?: string;
}): Promise<string> {
  const input: Record<string, unknown> = {
    kind: "confirm",
    question: "Policy requires confirmation before running some_write. Proceed?",
    commit_intent: {
      kind: "execute_confirmed_tool_call",
      payload: { tool: "some_write", approval_id: p.approvalId },
      description: "Run the gated tool.",
    },
    ...(p.approvalUrl ? { approval_url: p.approvalUrl } : {}),
  };
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: p.conversation_id,
      tool_name: "ask_user_confirm",
      summary: "confirm some_write",
      input,
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  return row!.id;
}

async function lastError(id: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ e: conversationElicitations.delivery_last_error })
    .from(conversationElicitations)
    .where(
      and(eq(conversationElicitations.tenant_id, tenant_id), eq(conversationElicitations.id, id)),
    );
  return row?.e ?? null;
}

describe("markApprovalElicitationsComplete", () => {
  test("approve marks the matching portal-path confirm row url_completed", async () => {
    const conversation_id = await freshConversation();
    const approvalId = uuid(1);
    const id = await seedConfirm({
      conversation_id,
      approvalId,
      approvalUrl: `https://engine.example/v1/tool-approvals/decide?grant=skag_${"a".repeat(20)}`,
    });

    const matched = await markApprovalElicitationsComplete(
      { tenant_id, approval_id: approvalId, outcome: "succeeded" },
      ctx.db,
    );

    expect(matched).toBe(1);
    expect(await lastError(id)).toBe("url_completed");
  });

  test("decline marks it url_failed", async () => {
    const conversation_id = await freshConversation();
    const approvalId = uuid(2);
    const id = await seedConfirm({
      conversation_id,
      approvalId,
      approvalUrl: `https://engine.example/v1/tool-approvals/decide?grant=skag_${"b".repeat(20)}`,
    });

    const matched = await markApprovalElicitationsComplete(
      { tenant_id, approval_id: approvalId, outcome: "failed" },
      ctx.db,
    );

    expect(matched).toBe(1);
    expect(await lastError(id)).toBe("url_failed");
  });

  test("a confirm row WITHOUT an approval_url is never matched — it never took the portal path", async () => {
    const conversation_id = await freshConversation();
    const approvalId = uuid(3);
    const id = await seedConfirm({ conversation_id, approvalId }); // no approval_url

    const matched = await markApprovalElicitationsComplete(
      { tenant_id, approval_id: approvalId, outcome: "succeeded" },
      ctx.db,
    );

    expect(matched).toBe(0);
    expect(await lastError(id)).toBeNull();
  });

  test("a different approval's row is left untouched", async () => {
    const conversation_id = await freshConversation();
    const mine = uuid(4);
    const other = uuid(5);
    const otherRow = await seedConfirm({
      conversation_id,
      approvalId: other,
      approvalUrl: `https://engine.example/v1/tool-approvals/decide?grant=skag_${"c".repeat(20)}`,
    });

    const matched = await markApprovalElicitationsComplete(
      { tenant_id, approval_id: mine, outcome: "succeeded" },
      ctx.db,
    );

    expect(matched).toBe(0);
    expect(await lastError(otherRow)).toBeNull();
  });

  test("an already-resolved row is not re-marked — only pending rows match", async () => {
    const conversation_id = await freshConversation();
    const approvalId = uuid(6);
    const id = await seedConfirm({
      conversation_id,
      approvalId,
      approvalUrl: `https://engine.example/v1/tool-approvals/decide?grant=skag_${"d".repeat(20)}`,
    });
    await ctx.db
      .update(conversationElicitations)
      .set({ status: "resolved" })
      .where(eq(conversationElicitations.id, id));

    const matched = await markApprovalElicitationsComplete(
      { tenant_id, approval_id: approvalId, outcome: "succeeded" },
      ctx.db,
    );

    expect(matched).toBe(0);
  });
});
