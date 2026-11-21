import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
  workflows,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { appendSnapshot } from "../draft.ts";
import { getElicitation } from "../elicitations.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist/index.ts";
import type { ToolContext } from "../tools/index.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import {
  ctx,
  freshConversation,
  readyWorkflowDraft,
  usePolicyGateSaveWorkflowDraftSetup,
} from "./policy-gate-save-workflow-draft-fixtures.ts";
import { freshSignals } from "./turn-signals.ts";

usePolicyGateSaveWorkflowDraftSetup();

describe("save_workflow_draft — policy gate", () => {
  test("LLM-issued save_workflow_draft pauses with kind=save_workflow_draft + commit_intent", async () => {
    const conversation_id = await freshConversation();
    const events: TurnEvent[] = [];
    const signals = freshSignals();
    const engineClient = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db,
    });
    const draft = readyWorkflowDraft("policy-gate-1");
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient,
      getDraft: () => draft,
      setDraft: async () => {},
    };

    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db,
      ["workflow-authoring"],
      {},
    );

    const saveWorkflowDraft = wrapped.save_workflow_draft;
    expect(saveWorkflowDraft).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (saveWorkflowDraft!.execute as any)(
      {},
      { toolCallId: "fake-llm-call-id", messages: [] },
    );

    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(result.pause?.kind).toBe("save_workflow_draft");
    expect(result.data).toMatchObject({
      pending: true,
      policy_mode: "confirm_before_execution",
    });

    const elicit = events.find((e) => e.type === "elicit_request");
    if (elicit?.type !== "elicit_request") {
      throw new Error("expected elicit_request event");
    }
    expect(elicit.tool_call_id).toBeDefined();
    const persisted = await getElicitation(ctx.tenant_id, elicit.elicitation_id, ctx.testDb.db);
    expect(persisted?.tool_name).toBe("ask_user_confirm");
    expect(persisted?.status).toBe("pending");
    const elicitInput = persisted?.input as Record<string, unknown>;
    expect(elicitInput.kind).toBe("save_workflow_draft");
    const commit_intent = elicitInput.commit_intent as Record<string, unknown> | undefined;
    expect(commit_intent).toBeDefined();
    expect(commit_intent?.kind).toBe("save_workflow_draft");
    expect(commit_intent?.payload).toBeDefined();

    const startEvent = events.find((event) => event.type === "tool_call_start");
    const endEvent = events.find((event) => event.type === "tool_call_end");
    const resultEvent = events.find((event) => event.type === "tool_result");
    expect(startEvent?.type).toBe("tool_call_start");
    expect(endEvent?.type).toBe("tool_call_end");
    expect(resultEvent?.type).toBe("tool_result");
    const parentMessageId =
      startEvent && startEvent.type === "tool_call_start" ? startEvent.parent_message_id : null;
    expect(parentMessageId).toBeDefined();
    if (
      !parentMessageId ||
      !endEvent ||
      endEvent.type !== "tool_call_end" ||
      !resultEvent ||
      resultEvent.type !== "tool_result"
    ) {
      throw new Error("expected anchored tool lifecycle events");
    }
    expect(endEvent.parent_message_id).toBe(parentMessageId);
    expect(resultEvent.parent_message_id).toBe(parentMessageId);
    expect(elicit.parent_message_id).toBe(parentMessageId);
    expect(persisted?.parent_message_id).toBe(parentMessageId);

    const messageRows = await ctx.testDb.db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversation_id));
    const assistantMessage = messageRows.find((row) => row.role === "assistant");
    expect(assistantMessage?.id).toBe(parentMessageId);
    expect(assistantMessage?.content).toEqual({});

    const [toolCallRow] = await ctx.testDb.db
      .select({
        parent_message_id: conversationToolCalls.parent_message_id,
      })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, elicit.tool_call_id ?? ""));
    expect(toolCallRow?.parent_message_id).toBe(parentMessageId);
  });

  test("save_workflow_draft with a fresh durable prior approval skips the policy gate", async () => {
    const conversation_id = await freshConversation();
    const events: TurnEvent[] = [];
    const signals = freshSignals();
    const engineClient = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db,
    });
    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "commit",
      input: {
        kind: "save_workflow_draft",
        summary: "commit",
        commit_intent: { kind: "save_workflow_draft", payload: {}, description: "commit" },
      },
      output: { confirmed: true },
      status: "resolved",
    });
    const draft = readyWorkflowDraft("policy-gate-2");
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => draft,
      setDraft: async () => {},
    };

    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db,
      ["workflow-authoring"],
      {},
    );

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.save_workflow_draft!.execute as any)(
      {},
      { toolCallId: "reissue-call-id", messages: [] },
    );

    expect(result.pause).toBeUndefined();
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.workflow_id).toBeDefined();
    expect(data.usage).toBeUndefined();
    expect(data.persistence_kind).toBe("draft");
    expect(data.activation_required).toBe(true);
    expect(data.current_version_id).toBeNull();
    expect(data.next_prompt as string).toContain(
      "no schedule, webhook or live execution was enabled",
    );
    expect(data.next_prompt as string).not.toContain("Skill-Candidate");
  });
});

describe("save_workflow_draft — auto-persist via commit_intent", () => {
  test("resolving an ask_user_confirm + commit_intent persists the workflow", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("auto-persist-wf");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    const [carrier] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Confirm save_workflow_draft (policy: confirm_before_execution)",
        input: {
          kind: "save_workflow_draft",
          question: "Save this workflow?",
          target: { tool: "save_workflow_draft", args: {} },
          commit_intent: {
            kind: "save_workflow_draft",
            payload: {},
            description: "Save the current workflow draft.",
          },
        },
        output: { confirmed: true },
        status: "resolved",
      })
      .returning();
    if (!carrier) throw new Error("failed to seed carrier elicitation");

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation: { id: carrier.id, tool_name: carrier.tool_name, input: carrier.input },
      db: ctx.testDb.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_workflow_draft");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    const persisted = wfRows.find((r) => r.slug === "auto-persist-wf");
    expect(persisted).toBeDefined();

    const calls = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    const synthetic = calls.find((c) => c.tool === "save_workflow_draft");
    expect(synthetic).toBeDefined();
    const out = synthetic!.output as Record<string, unknown>;
    expect(out.source).toBe("harness_auto_persist");
    expect(out.ok).toBe(true);
  });
});
