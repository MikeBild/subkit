import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("tool-loop-envelope");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("adaptive loop-breaker structured envelope", () => {
  it("tenant_read tools have NO repeat cap — inspect_execution_step is callable many times with same args", async () => {
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
      getDraft: () => ({ workflow: { name: "", steps: [] } }),
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
    const inspect = wrapped.inspect_execution_step;
    expect(inspect).toBeDefined();
    for (let i = 1; i <= 10; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (inspect!.execute as any)(
        {
          execution_id: "00000000-0000-0000-0000-000000000000",
          step_key: "any",
        },
        { toolCallId: `t${i}`, messages: [] },
      );
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("tool_loop_detected");
    }
  });

  it("write tools trip on consecutive identical args (REPEAT_THRESHOLD=3)", async () => {
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
    const editPatch = wrapped.edit_workflow_patch;
    expect(editPatch).toBeDefined();
    const sameArgs = {
      patches: [
        {
          op: "add",
          path: "/steps/-",
          value: {
            id: "x",
            kind: "transform",
            language: "javascript",
            expression: "return input.n;",
          },
        },
      ],
    };
    for (let i = 1; i <= 2; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (editPatch!.execute as any)(sameArgs, {
        toolCallId: `t${i}`,
        messages: [],
      });
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("tool_loop_detected");
    }
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result3 = await (editPatch!.execute as any)(sameArgs, {
      toolCallId: "t3",
      messages: [],
    });
    const data3 = result3.data as {
      error_code?: string;
      next_best_actions?: string[];
      message?: string;
      repeat_count?: number;
    };
    expect(data3.error_code).toBe("tool_loop_detected");
    expect(data3.next_best_actions).toEqual(
      expect.arrayContaining(["ask_user_choice", "ask_user_text"]),
    );
    expect(data3.message).toContain("ask_user_choice");
    expect(data3.repeat_count).toBeGreaterThanOrEqual(3);
  });

  it("write tools do NOT trip when args change between calls (legitimate incremental authoring)", async () => {
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
    const editPatch = wrapped.edit_workflow_patch;
    for (let i = 1; i <= 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (editPatch!.execute as any)(
        {
          patches: [
            {
              op: "add",
              path: "/steps/-",
              value: {
                id: `s${i}`,
                kind: "transform",
                language: "javascript",
                expression: "return input.n;",
              },
            },
          ],
        },
        { toolCallId: `t${i}`, messages: [] },
      );
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("tool_loop_detected");
    }
  });
});
