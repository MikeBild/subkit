import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import type { ConversationTool, ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import type { TurnSignals } from "../tools/sdk-wrap/state.ts";
import { getRawResult } from "../tools/truncate.ts";
import type { TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("sdk-wrap-truncated-return");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function freshSignals(): TurnSignals {
  return {
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
}

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

function bigOutputTool(payload: unknown): ConversationTool {
  return {
    name: "test_big_output",
    description: "Test tool returning a controlled payload.",
    inputSchema: z.object({}),
    category: "tenant_read",
    async execute() {
      return { ok: true, data: payload };
    },
  };
}

let toolCallSeq = 0;

async function invokeWrapped(payload: unknown): Promise<Record<string, unknown>> {
  const wrapped = wrapOne(
    bigOutputTool(payload),
    makeToolCtx(),
    freshSignals(),
    [] as TurnEvent[],
    ctx.testDb.db as unknown as Db,
    {},
    null,
    [],
  );
  toolCallSeq += 1;
  // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
  return (await (wrapped.execute as any)(
    {},
    { toolCallId: `t-${toolCallSeq}`, messages: [] },
  )) as Record<string, unknown>;
}

describe("sdk-wrap — truncated view goes back to the model, full payload persists", () => {
  test("an oversized payload returns truncated with recovery markers; the DB row keeps it whole", async () => {
    const payload = {
      big: "x".repeat(60_000),
      rows: Array.from({ length: 50 }, (_, i) => ({ i, blob: "y".repeat(500) })),
      summary: "done",
    };
    const result = await invokeWrapped(payload);

    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data._truncated).toBe(true);
    expect(typeof data._raw_ref).toBe("string");
    expect(typeof data._note).toBe("string");
    expect(JSON.stringify(data).length).toBeLessThan(20_000);
    const raw = getRawResult(data._raw_ref as string) as typeof payload;
    expect(raw.big.length).toBe(60_000);
    expect(raw.rows).toHaveLength(50);

    const [rowDb] = await ctx.testDb.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id))
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    const persisted = rowDb?.output as typeof payload;
    expect(persisted.big.length).toBe(60_000);
    expect(persisted.rows).toHaveLength(50);
  });

  test("control-flow markers survive truncation (stop conditions + stall fingerprint)", async () => {
    const payload = {
      step_trace: Array.from({ length: 40 }, (_, i) => ({ i, dump: "z".repeat(800) })),
      requires_repair: true,
      classification: "needs_repair",
      already_persisted: true,
      version_changed: false,
      judge: { missing: ["output_schema", "trigger"] },
      warnings: [{ code: "loop_body_empty" }, { code: "output_contract_violation" }],
    };
    const result = await invokeWrapped(payload);
    const data = result.data as Record<string, unknown>;

    expect(data._truncated).toBe(true);
    expect(data.requires_repair).toBe(true);
    expect(data.classification).toBe("needs_repair");
    expect(data.already_persisted).toBe(true);
    expect(data.version_changed).toBe(false);
    expect(data.judge).toEqual({ missing: ["output_schema", "trigger"] });
    expect(data.warnings).toEqual([
      { code: "loop_body_empty" },
      { code: "output_contract_violation" },
    ]);
  });

  test("a small payload passes through verbatim — no markers, no copy", async () => {
    const payload = { ok: true, note: "small result", items: [1, 2, 3] };
    const result = await invokeWrapped(payload);
    expect(result.data).toEqual(payload);
  });
});
