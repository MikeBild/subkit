import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversationElicitations, conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("post-execution-pause");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});
afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function makeToolCtx(): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: ctx.tenant_id,
    actor_id: null,
    actor_type: "system",
    db: ctx.testDb.db as unknown as Db,
  });
  return {
    db: ctx.testDb.db as unknown as Db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("post-execution review pause", () => {
  test("authenticate_oauth declares confirm_after_execution as defaultMode", async () => {
    const { TOOL_POLICIES } = await import("../../tool-policies.ts");
    expect(TOOL_POLICIES.authenticate_oauth?.defaultMode).toBe("confirm_after_execution");
  });

  test("getApprovalMode reflects confirm_after_execution as approval_after badge", async () => {
    const { getApprovalMode } = await import("../../tool-policies.ts");
    expect(getApprovalMode("authenticate_oauth")).toBe("approval_after");
  });

  test("the wrapped tool emits a synthetic review elicitation after a successful confirm_after_execution run", async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeToolCtx(),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["connector-creation-guidance", "oauth-flow"],
      {},
    );
    expect(wrapped.authenticate_oauth).toBeDefined();
    const { resolveToolMode } = await import("../../tool-policies.ts");
    const mode = resolveToolMode({
      tool: "authenticate_oauth",
      category: "tenant_write",
      input: { connector_id: "00000000-0000-0000-0000-000000000001" },
      overrides: {},
      permission_mode: null,
    });
    expect(mode).toBe("confirm_after_execution");
  });

  test("review-after-execution elicitation row carries kind=review_after_execution + the tool result", async () => {
    const { createElicitation } = await import("../../elicitations.ts");
    const synthetic = await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "Review result of authenticate_oauth",
        input: {
          kind: "review_after_execution",
          summary: "Review result of authenticate_oauth",
          target: { tool: "authenticate_oauth", args: { connector_id: "x" } },
          pending_output: {
            scopes: ["read", "write"],
            expires_at: "2026-12-31T00:00:00.000Z",
          },
        },
        actor_id: null,
      },
      ctx.testDb.db as unknown as Db,
    );
    const rows = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, synthetic.id))
      .limit(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.tool_name).toBe("ask_user_confirm");
    const input = row?.input as { kind?: string; pending_output?: { scopes?: string[] } };
    expect(input.kind).toBe("review_after_execution");
    expect(input.pending_output?.scopes).toEqual(["read", "write"]);
  });
});
