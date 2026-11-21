import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../tools/index.ts";
import { GENERIC_TOOL_FAILURE_CODE } from "../tools/result-payload.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import type { TurnSignals } from "../tools/sdk-wrap/state.ts";
import type { TurnEvent } from "../types.ts";
import { freshSignals } from "./turn-signals.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("sdk-wrap-failure-envelope");
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
  return {
    db: ctx.testDb.db as unknown as Db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db as unknown as Db,
    }),
    getDraft: () => ({}) as ReturnType<ToolContext["getDraft"]>,
    setDraft: async () => {},
  };
}

function failingTool(name: string, run: () => Promise<ToolResult>): ConversationTool {
  return {
    name,
    description: "Test tool with a controlled failure.",
    inputSchema: z.object({}),
    category: "tenant_read",
    execute: run,
  };
}

let toolCallSeq = 0;

async function invoke(
  inner: ConversationTool,
  signals: TurnSignals = freshSignals(),
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const wrapped = wrapOne(
    inner,
    makeToolCtx(),
    signals,
    [] as TurnEvent[],
    ctx.testDb.db as unknown as Db,
    {},
  );
  toolCallSeq += 1;
  // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
  return (await (wrapped.execute as any)(
    {},
    { toolCallId: `fe-${toolCallSeq}`, messages: [] },
  )) as { ok: boolean; data: Record<string, unknown> };
}

async function lastPersistedOutput(): Promise<unknown> {
  const [row] = await ctx.testDb.db
    .select({ output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, conversation_id))
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(1);
  return row?.output;
}

describe("sdk-wrap failure envelope", () => {
  test("a thrown error returns and persists tool_execution_failed with recovery actions", async () => {
    const result = await invoke(
      failingTool("test_throws", async () => {
        throw new Error("upstream unavailable");
      }),
    );

    const expected = {
      ok: false,
      error: "upstream unavailable",
      error_code: "tool_execution_failed",
      message: "upstream unavailable",
      next_best_actions: [],
    };
    expect(result).toEqual({ ok: false, data: expected });
    expect(await lastPersistedOutput()).toEqual(expected);
  });

  test("a thrown database error is masked in output and persistence", async () => {
    const result = await invoke(
      failingTool("test_db_throws", async () => {
        throw new Error('Failed query: select 1 where token = $1\nparams: "s3cr3t"');
      }),
    );

    expect(result.data).toMatchObject({
      error_code: "tool_execution_failed",
      message: "the lookup failed; check the arguments",
      next_best_actions: [],
    });
    expect(JSON.stringify(await lastPersistedOutput())).not.toContain("s3cr3t");
  });

  test("a bare prose error gains the canonical fields without opening an error-code streak", async () => {
    const signals = freshSignals();
    const result = await invoke(
      failingTool("test_bare_error", async () => ({
        ok: false,
        data: { error: "the sample record is locked" },
      })),
      signals,
    );

    expect(result).toEqual({
      ok: false,
      data: {
        error: "the sample record is locked",
        error_code: GENERIC_TOOL_FAILURE_CODE,
        message: "the sample record is locked",
        next_best_actions: [],
      },
    });
    expect(signals.toolErrorCodeRepeat.has("test_bare_error")).toBe(false);
  });

  test("a tool-declared code still counts toward the error-code streak", async () => {
    const signals = freshSignals();
    await invoke(
      failingTool("test_coded_error", async () => ({
        ok: false,
        data: { error_code: "connector_scope_required", error: "no connector in scope" },
      })),
      signals,
    );

    expect(signals.toolErrorCodeRepeat.get("test_coded_error")).toEqual({
      code: "connector_scope_required",
      count: 1,
    });
  });
});
