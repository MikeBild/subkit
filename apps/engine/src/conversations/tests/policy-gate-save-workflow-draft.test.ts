// Regression test for the save_workflow_draft policy-gate bypass + auto-persist
// path. Covers the bug observed in session dca36b29 (engine logs at
// 2026-04-28T05:00:57Z) where:
//   - The LLM called save_workflow_draft directly.
//   - tool_policy.confirmation_required fired, but the gate skipped
//     pause + elicit (sdk-wrap.ts:393's `category === "tenant_write"`
//     filter excluded `save_workflow_draft`'s `draft_write` category).
//   - The tool ran immediately and died with `no_prior_approval`.
//
// Two scenarios cover the fix end to end:
//   1. policy gate now PAUSES save_workflow_draft and emits an elicit_request
//      with kind=save_workflow_draft AND a commit_intent payload that the
//      harness can auto-persist.
//   2. resolving that elicitation with confirmed:true via
//      maybeAutoPersistFromElicitation atomically writes the workflow
//      via the auto-persist path (no LLM re-issue needed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  workflows,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import {
  withLatestPreview,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { appendSnapshot } from "../draft.ts";
import { getElicitation } from "../elicitations.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import { findPriorSaveWorkflowApproval } from "../persistence/save-workflow-approval.ts";
import type { ToolContext } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { DraftDocument, TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("policy-gate-save-workflow-draft");
});

afterAll(async () => {
  await ctx.cleanup();
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
  };
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("failed to seed conversation");
  return row.id;
}

function readyWorkflowDraft(slug: string): DraftDocument {
  const base: DraftDocument = {
    mode: "workflow_authoring",
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          expression: "$input",
          language: "jsonata",
        },
      ],
    },
  };
  // Mirror the readiness contract commitWorkflowAtomic enforces:
  // inspect + validate + at least one successful preview must be
  // recorded in the draft state.
  const inspected = withWorkflowInspection(base);
  const validated = withWorkflowValidation(inspected, true, "Workflow draft validated.");
  return withLatestPreview(validated, {
    ok: true,
    summary: "preview ok",
    warnings: [],
  });
}

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

    // The wrapper paused before save_workflow_draft.execute could run — no
    // workflow row exists yet, no `no_prior_approval` was returned.
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(result.pause?.kind).toBe("save_workflow_draft");
    expect(result.data).toMatchObject({
      pending: true,
      policy_mode: "confirm_before_execution",
    });

    // The synthesised elicitation carries the right top-level kind so
    // the inner prior-approval gate (commit-workflow.ts:63) finds it
    // on a re-issue, AND a commit_intent so the harness auto-persist
    // can fire on confirm without an LLM round-trip.
    const elicit = events.find((e) => e.type === "elicit_request");
    if (!elicit || elicit.type !== "elicit_request") {
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

  test("LLM-issued save_workflow_draft with __policy_confirmed: true skips the policy gate", async () => {
    // Re-issue path: after the user confirms via the policy-gate
    // elicitation, the LLM is told to re-call with this marker. The
    // gate must not fire a second time.
    const conversation_id = await freshConversation();
    const events: TurnEvent[] = [];
    const signals = freshSignals();
    const engineClient = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db,
    });
    // Pre-seed a resolved ask_user_confirm carrying
    // commit_intent.kind:save_workflow_draft so the inner prior-approval
    // gate (which authorizes on the commit_intent, not the cosmetic
    // top-level kind) also passes.
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
      { __policy_confirmed: true },
      { toolCallId: "reissue-call-id", messages: [] },
    );

    // No pause this time — the marker bypasses the gate, the inner
    // prior-approval check finds the resolved elicit, and the
    // workflow gets persisted.
    expect(result.pause).toBeUndefined();
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.workflow_id).toBeDefined();
  });

  test('LLM-issued save_workflow_draft with __policy_confirmed: "true" (string) is coerced and skips the gate (G2)', async () => {
    // Root cause of G2 in the runtime-logs review plan: Anthropic's
    // tool-call serialiser sometimes round-trips the boolean as
    // `"true"` (string). Pre-fix the AI SDK Zod boundary rejected
    // with `expected boolean, received string`, the model emitted
    // `repair_tool_call.started`, and the engine spent ~8s asking the
    // model to fix the type — on EVERY OAuth call (4 separate
    // instances logged in session ed20f48d). The wrapper now accepts
    // both representations and coerces; downstream semantics unchanged.
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
    const draft = readyWorkflowDraft("policy-gate-2-coerce");
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

    // String-form marker — exactly what the SDK produced in production.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.save_workflow_draft!.execute as any)(
      { __policy_confirmed: "true" },
      { toolCallId: "reissue-call-id-string", messages: [] },
    );

    expect(result.pause).toBeUndefined();
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.workflow_id).toBeDefined();
  });
});

describe("save_workflow_draft — auto-persist via commit_intent", () => {
  test("resolving an ask_user_confirm + commit_intent persists the workflow", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("auto-persist-wf");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    // Simulate the carrier elicitation the policy gate (or an
    // LLM-emitted ask_user_confirm) would have produced.
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

    // The workflow was actually written. Pre-fix this assertion
    // would fail because no_prior_approval blocked the write.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    const persisted = wfRows.find((r) => r.slug === "auto-persist-wf");
    expect(persisted).toBeDefined();

    // A synthetic tool-call row was injected with
    // source=harness_auto_persist so the LLM's next turn sees the
    // commit as a normal tool result and does NOT need to re-issue.
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

describe("commit gate — authorizes on commit_intent.kind, not top-level kind", () => {
  test("PRODUCTION CASE: generic-kind confirm + save_workflow_draft commit_intent authorizes the commit", async () => {
    // The exact stuck-conversation row: top-level `kind:"generic"`,
    // `commit_intent.kind:"save_workflow_draft"`, `confirmed:true`.
    // Pre-fix the commit gate keyed on `input->>'kind' =
    // 'save_workflow_draft'` and rejected it → no_prior_approval →
    // conversation_commit dead-ended with "no committed workflow".
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-prod-case");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    // Seed the multi-turn elicitation history exactly as observed:
    // an external_write resolved + cancelled, a review_after_execution
    // resolved, then the decisive generic-kind save approval.
    await ctx.testDb.db.insert(conversationElicitations).values([
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "external write",
        input: { kind: "external_write", target: { tool: "call_connector" } },
        output: { confirmed: true },
        status: "resolved",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "external write cancelled",
        input: { kind: "external_write", target: { tool: "call_connector" } },
        status: "cancelled",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "post-exec review",
        input: { kind: "review_after_execution" },
        output: { confirmed: true },
        status: "resolved",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "save the workflow",
        input: {
          kind: "generic",
          commit_intent: {
            kind: "save_workflow_draft",
            payload: {},
            description: "Save the current workflow draft.",
          },
        },
        output: { confirmed: true },
        status: "resolved",
      },
    ]);

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      permission_mode: "ask",
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };

    // The prior-approval gate runs (skipPriorApprovalCheck omitted).
    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(true);
    expect(result.committed_workflow_id).toBeDefined();

    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(wfRows.find((r) => r.slug === "commit-gate-prod-case")).toBeDefined();
  });

  test("an external_write confirm with NO save-workflow commit_intent does NOT authorize the commit", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-no-intent");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    // Only an external_write confirm exists — no commit_intent.
    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "external write",
      input: { kind: "external_write", target: { tool: "call_connector" } },
      output: { confirmed: true },
      status: "resolved",
    });

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      permission_mode: "ask",
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };

    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.error_code).toBe("no_prior_approval");
  });

  test("non-save dedup matches on input.target.tool — not a shared kind bucket", async () => {
    // The non-`save_workflow_draft` dedup keys on the ORIGINATING tool
    // (`input.target.tool`, stamped on every policy-gate elicitation),
    // not the cosmetic top-level `kind`. A recent resolved confirm
    // whose `target.tool` equals the current tool must dedup the
    // pre-confirm; a confirm for a DIFFERENT tool must NOT — even
    // though both bucket to the same `external_write` kind, which is
    // the cross-intent false positive the fix closes.

    // (a) MATCH: a resolved confirm for run_workflow → pre-confirm skipped.
    {
      const conversation_id = await freshConversation();
      await ctx.testDb.db.insert(conversationElicitations).values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "run the workflow",
        input: {
          kind: "external_write",
          question: "Run this workflow?",
          target: { tool: "run_workflow", args: {} },
        },
        output: { confirmed: true },
        status: "resolved",
      });

      const events: TurnEvent[] = [];
      const signals = freshSignals();
      const engineClient = new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      });
      const toolCtx: ToolContext = {
        db: ctx.testDb.db,
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
        ctx.testDb.db,
        ["workflow-authoring"],
        {},
      );

      // run_workflow in prod mode → confirm_before_execution. The
      // recent run_workflow confirm dedups the pre-confirm, so the
      // inner tool runs (and fails workflow_not_found on the fake id —
      // proof the gate did NOT pause).
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (wrapped.run_workflow!.execute as any)(
        { workflow_id: "00000000-0000-0000-0000-000000000000", environment: "prod" },
        { toolCallId: "dedup-match-call", messages: [] },
      );
      expect(result.pause).toBeUndefined();
      // No policy-gate elicitation was synthesised this turn.
      const elicit = events.find((e) => e.type === "elicit_request");
      expect(elicit).toBeUndefined();
    }

    // (b) NO MATCH: the only recent confirm targets a DIFFERENT tool
    // (web_search) → no cross-intent dedup → run_workflow still pauses.
    {
      const conversation_id = await freshConversation();
      await ctx.testDb.db.insert(conversationElicitations).values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "run the web search",
        input: {
          kind: "external_write",
          question: "Run this web search?",
          target: { tool: "web_search", args: {} },
        },
        output: { confirmed: true },
        status: "resolved",
      });

      const events: TurnEvent[] = [];
      const signals = freshSignals();
      const engineClient = new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      });
      const toolCtx: ToolContext = {
        db: ctx.testDb.db,
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
        ctx.testDb.db,
        ["workflow-authoring"],
        {},
      );

      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (wrapped.run_workflow!.execute as any)(
        { workflow_id: "00000000-0000-0000-0000-000000000000", environment: "prod" },
        { toolCallId: "dedup-nomatch-call", messages: [] },
      );
      // The web_search confirm does NOT dedup a run_workflow gate —
      // the pre-confirm fires and the tool is paused before execution.
      expect(result.ok).toBe(false);
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_confirm");
      expect(result.data).toMatchObject({
        pending: true,
        policy_mode: "confirm_before_execution",
      });
      const elicit = events.find((e) => e.type === "elicit_request");
      expect(elicit).toBeDefined();
    }
  });

  test("policy gate and commit gate agree — both consult the shared predicate", async () => {
    // Regression: the two gates must never disagree. We assert the
    // shared predicate's verdict matches the commit gate's outcome for
    // the production-shaped approval row.
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-agreement");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "save the workflow",
      input: {
        kind: "generic",
        commit_intent: {
          kind: "save_workflow_draft",
          payload: {},
          description: "Save the current workflow draft.",
        },
      },
      output: { confirmed: true },
      status: "resolved",
    });

    // The shared predicate (used by the policy gate's
    // recentlyConfirmedByLLM detection) sees an approval...
    const approval = await findPriorSaveWorkflowApproval(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
    );
    expect(approval).not.toBeNull();

    // ...and the commit gate (which consults the SAME predicate)
    // therefore accepts the commit. Identical verdict → no divergence.
    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      permission_mode: "ask",
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };
    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(true);
  });
});
