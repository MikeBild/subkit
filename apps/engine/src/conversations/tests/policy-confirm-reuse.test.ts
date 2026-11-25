import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getElicitation } from "../elicitations.ts";
import { elicitationInputForClient } from "../tools/ask-user/commit-intent.ts";
import type { ToolContext } from "../tools/index.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";
import { freshSignals } from "./turn-signals.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("policy-confirm-reuse");
  await setConfigKey("server.public_base_url", "https://engine.example.test", { force: true });
});

afterAll(async () => {
  await ctx.cleanup();
});

const policyConfirmInvoker = async () => {
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, owner_id: ctx.user_id, status: "active" })
    .returning();
  if (!conversation) throw new Error("failed to seed conversation");
  const toolCtx: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversation.id,
    actor_id: ctx.user_id,
    principal: {
      provider: "test",
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    },
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
  let invocation = 0;
  const invoke = async () => {
    invocation += 1;
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db,
      ["workflow-authoring"],
      { run_workflow: "confirm_before_execution" },
    );
    const execute = wrapped.run_workflow?.execute;
    if (!execute) throw new Error("missing run_workflow");
    const result = await execute(
      { workflow: "reuse-test", environment: "prod", execute_writes: true },
      { toolCallId: `00000000-0000-4000-8000-00000000000${invocation}`, messages: [], context: {} },
    );
    return { result, signals, events };
  };
  return { conversation, invoke };
};

test("reused policy confirmation publishes the persisted approval metadata", async () => {
  const { conversation, invoke } = await policyConfirmInvoker();
  const first = await invoke();
  const firstId = first.signals.pendingElicitation?.elicitation_id;
  expect(firstId).toBeDefined();
  const persisted = await getElicitation(ctx.tenant_id, firstId!, ctx.testDb.db);
  const input = elicitationInputForClient(persisted?.input) as Record<string, unknown>;
  expect(input.approval_url).toMatch(/^https:\/\/engine\.example\.test\//);
  const second = await invoke();
  expect(second.signals.pendingElicitation?.elicitation_id).toBe(firstId);
  expect(second.result).toMatchObject({
    data: { approval_url: input.approval_url },
    pause: { input, summary: persisted?.summary },
  });
  expect(second.signals.pendingElicitation?.input).toEqual(input);
  expect(second.events.find((event) => event.type === "elicit_request")).toMatchObject({ input });
  const calls = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, conversation.id));
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.output).toMatchObject({ approval_url: input.approval_url });
});

test("an expired but still pending approval for the same action is not reused", async () => {
  const { conversation, invoke } = await policyConfirmInvoker();
  const first = await invoke();
  const firstId = first.signals.pendingElicitation?.elicitation_id;
  if (!firstId) throw new Error("missing first elicitation");
  await ctx.testDb.db
    .update(conversationElicitations)
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where(eq(conversationElicitations.id, firstId));
  const second = await invoke();
  const secondId = second.signals.pendingElicitation?.elicitation_id;
  if (!secondId) throw new Error("missing second elicitation");
  expect(secondId).not.toBe(firstId);
  const rows = await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, conversation.id));
  expect(rows.filter((row) => row.status === "pending").map((row) => row.id)).toEqual([secondId]);
  const fresh = rows.find((row) => row.id === secondId);
  expect(fresh?.expires_at.getTime()).toBeGreaterThan(Date.now());
});
