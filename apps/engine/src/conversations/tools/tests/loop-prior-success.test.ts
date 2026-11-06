import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import { synthesizeFallbackMessage } from "../../turn-helpers.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("loop-prior-success");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("loop guard — prior-success attachment", () => {
  it("a tripped run_workflow whose identical call succeeded returns prior_success_output", async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const engineClient = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db as unknown as Db,
    });
    const toolCtx: ToolContext = {
      db: ctx.testDb.db as unknown as Db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => ({ workflow: { name: "t", steps: [] } }),
      setDraft: async () => {},
    };
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const run = wrapped.run_workflow;
    expect(run).toBeDefined();

    const sameArgs = { workflow: "org-top-repos", input: '{"org":"remotion-dev"}' };
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (run!.execute as any)(sameArgs, { toolCallId: "t1", messages: [] });
    const recordedHash = signals.toolArgsRepeat.get("run_workflow")?.hash;
    expect(typeof recordedHash).toBe("string");

    const successPayload = {
      status: "succeeded",
      output: { org: "remotion-dev", total: 95, top: [{ name: "remotion", stars: 49560 }] },
    };
    signals.lastExecutionSuccess = {
      tool: "run_workflow",
      args_hash: recordedHash!,
      output: successPayload,
    };

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result2 = await (run!.execute as any)(sameArgs, { toolCallId: "t2", messages: [] });
    const data2 = result2.data as {
      error_code?: string;
      message?: string;
      prior_success_output?: unknown;
      repeat_count?: number;
    };
    expect(data2.error_code).toBe("tool_loop_detected");
    expect(data2.repeat_count).toBe(2);
    expect(data2.prior_success_output).toEqual(successPayload);
    expect(data2.message).toContain("prior_success_output");
  });

  it("fallback synthesis describes the prior success instead of the abort", () => {
    const text = synthesizeFallbackMessage({
      loopWarnings: 1,
      events: [
        {
          type: "tool_result",
          call_id: "c1",
          tool: "run_workflow",
          output: {
            ok: false,
            reason: "tool_loop_detected",
            error_code: "tool_loop_detected",
            prior_success_output: {
              status: "succeeded",
              output: { total: 95 },
            },
          },
        } as unknown as TurnEvent,
      ],
    });
    expect(text).toContain("already succeeded this turn");
    expect(text).toContain("status=succeeded");
    expect(text).not.toContain("no output");
  });
});
