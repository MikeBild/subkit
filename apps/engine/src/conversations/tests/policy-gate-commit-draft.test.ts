// Regression test for the commit_draft policy-gate bypass + auto-persist
// path. Covers the bug observed in session dca36b29 (engine logs at
// 2026-04-28T05:00:57Z) where:
//   - The LLM called commit_draft directly.
//   - tool_policy.confirmation_required fired, but the gate skipped
//     pause + elicit (sdk-wrap.ts:393's `category === "tenant_write"`
//     filter excluded `commit_draft`'s `draft_write` category).
//   - The tool ran immediately and died with `no_prior_approval`.
//
// Two scenarios cover the fix end to end:
//   1. policy gate now PAUSES commit_draft and emits an elicit_request
//      with kind=commit_draft AND a commit_intent payload that the
//      harness can auto-persist.
//   2. resolving that elicitation with confirmed:true via
//      maybeAutoPersistFromElicitation atomically writes the workflow
//      via the auto-persist path (no LLM re-issue needed).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
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
import type { ToolContext } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { DraftDocument, TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("policy-gate-commit-draft");
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

describe("commit_draft — policy gate", () => {
  test("LLM-issued commit_draft pauses with kind=commit_draft + commit_intent", async () => {
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

    const wrapped = wrapTools(toolCtx, signals, events, ctx.testDb.db, ["workflow-authoring"], {});

    const commitDraft = wrapped.commit_draft;
    expect(commitDraft).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (commitDraft!.execute as any)(
      {},
      { toolCallId: "fake-llm-call-id", messages: [] },
    );

    // The wrapper paused before commit_draft.execute could run — no
    // workflow row exists yet, no `no_prior_approval` was returned.
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(result.pause?.kind).toBe("commit_draft");
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
    expect(elicitInput.kind).toBe("commit_draft");
    const commit_intent = elicitInput.commit_intent as Record<string, unknown> | undefined;
    expect(commit_intent).toBeDefined();
    expect(commit_intent?.kind).toBe("commit_workflow_draft");
    expect(commit_intent?.payload).toBeDefined();
  });

  test("LLM-issued commit_draft with __policy_confirmed: true skips the policy gate", async () => {
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
    // Pre-seed a resolved ask_user_confirm{kind:commit_draft} so the
    // inner prior-approval gate also passes.
    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "commit",
      input: { kind: "commit_draft", summary: "commit" },
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

    const wrapped = wrapTools(toolCtx, signals, events, ctx.testDb.db, ["workflow-authoring"], {});

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.commit_draft!.execute as any)(
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
});

describe("commit_draft — auto-persist via commit_intent", () => {
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
        summary: "Confirm commit_draft (policy: confirm_before_execution)",
        input: {
          kind: "commit_draft",
          question: "Save this workflow?",
          target: { tool: "commit_draft", args: {} },
          commit_intent: {
            kind: "commit_workflow_draft",
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
    expect(dispatch.synthetic_result?.tool).toBe("commit_draft");
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
    const synthetic = calls.find((c) => c.tool === "commit_draft");
    expect(synthetic).toBeDefined();
    const out = synthetic!.output as Record<string, unknown>;
    expect(out.source).toBe("harness_auto_persist");
    expect(out.ok).toBe(true);
  });
});
