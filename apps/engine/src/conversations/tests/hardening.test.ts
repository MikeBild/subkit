import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationMessages, llmUsage, tenants } from "../../db/schema/index.ts";
import type { LlmProviderError } from "../../llm/errors.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";

import type { ConversationTool, ToolContext, ToolResult } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("hardening");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function providerFailureNotices(): Promise<string[]> {
  const rows = await ctx.testDb.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.role, "assistant"),
      ),
    );
  return rows
    .map((row) => row.content as { text?: string; _reason?: string })
    .filter((content) => content._reason === "provider_failure_notice")
    .map((content) => content.text ?? "");
}

describe("conversations/hardening", () => {
  test("wrapTools serializes concurrent tool invocations via toolChain", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const markerTool: ConversationTool = {
      name: "marker",
      description: "serialization marker tool",
      // biome-ignore lint/suspicious/noExplicitAny: test fixture schema
      inputSchema: { parse: (x: unknown) => x } as any,
      category: "draft_write",
      async execute(_ctx: ToolContext, rawArgs: unknown): Promise<ToolResult> {
        const args = rawArgs as { id: string; delay: number };
        started.push(args.id);
        await new Promise((r) => setTimeout(r, args.delay)); // allow-wall-clock: fixture-injected delay reproduces the real upstream RTT under test
        finished.push(args.id);
        return { ok: true, data: { echoed: args.id } };
      },
    };

    const { EngineClient } = await import("../../engine-client/index.ts");
    const toolCtx: ToolContext = {
      db: ctx.testDb.db as unknown as Db,
      tenant_id: ctx.tenant_id,
      conversation_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        db: ctx.testDb.db as unknown as Db,
      }),
      getDraft: () => ({ workflow: { name: "t", steps: [] } }),
      setDraft: async () => {},
    };

    const convo = await createConversationWithTurn(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: "hello" },
      ctx.testDb.db,
    );
    toolCtx.conversation_id = convo.conversation.id;

    const signals: TurnSignals = {
      step: 0,
      toolChain: Promise.resolve(),
      pendingChildToolCallIds: [],
      pendingChildElicitationIds: [],
      toolInvocationCount: new Map(),
      toolLastErrorHash: new Map(),
      toolArgsRepeat: new Map(),
      toolValidationFingerprint: new Map(),
      toolErrorCodeRepeat: new Map(),
      totalLoopWarnings: 0,
      consecutiveFailures: 0,
      lastAssistantText: "",
      lastExecutionSuccess: null,
    };
    const events: TurnEvent[] = [];
    const tools = await wrapTools(toolCtx, signals, events, ctx.testDb.db);
    void markerTool;

    const listSkills = tools.list_skills;
    expect(listSkills).toBeDefined();
    const call = (i: number) =>
      // biome-ignore lint/suspicious/noExplicitAny: direct execute access
      (listSkills!.execute as any)({}, { toolCallId: `tc-${i}`, messages: [] });

    const resolved: number[] = [];
    const p1 = call(1).then(() => resolved.push(1));
    const p2 = call(2).then(() => resolved.push(2));
    const p3 = call(3).then(() => resolved.push(3));
    await Promise.all([p1, p2, p3]);

    expect(resolved).toEqual([1, 2, 3]);
    expect(signals.step).toBe(3);
    const kinds = events.map((e) => e.type).filter((k) => k !== "activity");
    expect(kinds).toEqual([
      "tool_call_start",
      "tool_call_end",
      "tool_result",
      "tool_call_start",
      "tool_call_end",
      "tool_result",
      "tool_call_start",
      "tool_call_end",
      "tool_result",
    ]);
  });

  test("turn-level fallback retries with the fallback model on overloaded", async () => {
    resetMockProvider();
    await ctx.testDb.db
      .update(tenants)
      .set({ llm_primary: "hardening-primary", llm_fallback: "hardening-fallback" })
      .where(eq(tenants.id, ctx.tenant_id));

    getMockProvider().setFailure("hardening-primary", "overloaded");

    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "please list users from the api",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );
    expect(outcome.result.status).toBe("awaiting_input");

    const primaryErr = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "hardening-primary"),
          eq(llmUsage.result, "error"),
        ),
      );
    expect(primaryErr.length).toBe(1);

    const fallbackSuccess = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "hardening-fallback"),
          eq(llmUsage.result, "success"),
        ),
      );
    expect(fallbackSuccess.length).toBeGreaterThanOrEqual(1);
  });

  test("a provider that fails on primary and fallback leaves a visible reply pointing to the AI settings", async () => {
    resetMockProvider();
    await ctx.testDb.db
      .update(tenants)
      .set({ llm_primary: "notice-primary", llm_fallback: "notice-fallback" })
      .where(eq(tenants.id, ctx.tenant_id));
    getMockProvider().setFailure("notice-primary", "overloaded");
    getMockProvider().setFailure("notice-fallback", "overloaded");

    const before = (await providerFailureNotices()).length;
    await expect(
      createConversationWithTurn(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          connector_id: ctx.connector_id,
          initial_message: "please list users from the api",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({ kind: "overloaded" } satisfies Partial<LlmProviderError>);

    const notices = await providerFailureNotices();
    expect(notices).toHaveLength(before + 1);
    expect(notices.some((text) => text.includes("Settings → AI & cost"))).toBe(true);
  });

  test("quota-exhausted on the same provider does not waste a fallback attempt", async () => {
    resetMockProvider();
    await ctx.testDb.db
      .update(tenants)
      .set({ llm_primary: "quota-primary", llm_fallback: "quota-fallback" })
      .where(eq(tenants.id, ctx.tenant_id));

    getMockProvider().setFailure("quota-primary", "quota_exhausted");
    const noticesBefore = (await providerFailureNotices()).length;

    await expect(
      createConversationWithTurn(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          connector_id: ctx.connector_id,
          initial_message: "please list users from the api",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({
      kind: "quota_exhausted",
    } satisfies Partial<LlmProviderError>);

    const primaryErr = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "quota-primary"),
          eq(llmUsage.result, "error"),
        ),
      );
    expect(primaryErr.length).toBe(1);

    const fallbackRows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.model, "quota-fallback")));
    expect(fallbackRows.length).toBe(0);
    expect(await providerFailureNotices()).toHaveLength(noticesBefore);
  });
});
