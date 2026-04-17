// Conversation tool-use loop.
//
// The loop drives one turn at a time:
//
//   1. Append the user message (if provided).
//   2. Repeatedly ask the LLM for the next tool call via the
//      `converse` flow. In tests the mock provider returns a canned
//      plan keyed by conversation id; in production this seam swaps
//      in a real tool-calling SDK call.
//   3. For each tool call:
//        a. persist `conversation_tool_calls` row
//        b. execute the tool
//        c. persist the tool result
//        d. emit a `tool_call` + `tool_result` TurnEvent
//   4. Stop when the LLM signals `done`, a tool pauses for approval,
//      or the step budget is hit.
//
// The loop is step-count bounded (default 20) to keep runaway plans
// in check. Validation errors from a tool are fed back into the LLM
// as additional context on the next iteration.

import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations, conversationToolCalls } from "../db/schema/index.ts";
import { monthlyUsage } from "../llm/budgets.ts";
import { assembleEnhancedPrompt } from "../llm/context.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { callWithFallback, resolveModelRoute } from "../llm/provider.ts";
import { log } from "../logging/logger.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { type ConversationTool, getTool, type ToolContext } from "./tools/index.ts";
import type { DraftDocument, TurnEvent } from "./types.ts";

export interface RunLoopParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  user_message: string | null;
  step_budget?: number;
  /** Optional user-supplied memory payload to thread into context assembly. */
  user_memory?: string | null;
  /** Optional per-turn model override resolved from conversations.model. */
  model_override?: string | null;
}

export interface RunLoopResult {
  events: TurnEvent[];
  status: "awaiting_approval" | "committed" | "active" | "exhausted";
  committed_workflow_id?: string;
  pending_approval_id?: string;
}

const DEFAULT_BUDGET = 20;

/**
 * Compact summary of a tool's return payload so every tool.succeeded
 * log carries *some* shape info without each tool having to add bespoke
 * fields. Array lengths, object key counts, and `errors[].length` land
 * here; primitive payloads are ignored.
 */
function summarizeToolData(data: unknown): Record<string, number | string | boolean> {
  if (data === null || data === undefined) return {};
  if (Array.isArray(data)) return { data_length: data.length };
  if (typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const out: Record<string, number | string | boolean> = {};
  // Well-known fields that tools tend to return.
  if (Array.isArray(obj.errors)) out.error_count = (obj.errors as unknown[]).length;
  if (Array.isArray(obj.hits)) out.hit_count = (obj.hits as unknown[]).length;
  if (Array.isArray(obj.skills)) out.skill_count = (obj.skills as unknown[]).length;
  if (Array.isArray(obj.items)) out.item_count = (obj.items as unknown[]).length;
  if (typeof obj.steps === "number") out.steps = obj.steps;
  if (typeof obj.step_count === "number") out.step_count = obj.step_count;
  if (typeof obj.workflow_id === "string") out.workflow_id = obj.workflow_id;
  if (typeof obj.connector_id === "string") out.connector_id = obj.connector_id;
  if (typeof obj.skill_id === "string") out.skill_id = obj.skill_id;
  if (typeof obj.step_id === "string") out.step_id = obj.step_id;
  if (typeof obj.last_step_id === "string") out.last_step_id = obj.last_step_id;
  if (typeof obj.step_type === "string") out.step_type = obj.step_type;
  if (typeof obj.slug === "string") out.slug = obj.slug;
  if (typeof obj.approval_id === "string") out.approval_id = obj.approval_id;
  if (typeof obj.reason === "string") out.reason = obj.reason;
  if (typeof obj.error === "string") out.error = obj.error;
  if (typeof obj.replaced === "boolean") out.replaced = obj.replaced;
  out.data_keys = Object.keys(obj).length;
  return out;
}

function isPlanDone(obj: unknown): boolean {
  return obj !== null && typeof obj === "object" && (obj as Record<string, unknown>).done === true;
}

function parseToolStep(obj: unknown): { tool: string; args: Record<string, unknown> } | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.tool !== "string") return null;
  const args = (rec.args ?? {}) as Record<string, unknown>;
  return { tool: rec.tool, args };
}

async function appendMessage(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  role: "user" | "assistant" | "tool" | "system",
  content: unknown,
): Promise<void> {
  await db
    .insert(conversationMessages)
    .values({ tenant_id, conversation_id, role, content: content as Record<string, unknown> });
}

async function buildConversationUserPrompt(
  conversation_id: string,
  lastUser: string,
): Promise<string> {
  // The mock provider pulls the conversation id out of this envelope
  // to look up the canned plan cursor.
  return `[conv:${conversation_id}] ${lastUser}`;
}

async function loadPriorTurns(
  db: Db,
  conversation_id: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await db
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversation_id, conversation_id))
    .orderBy(asc(conversationMessages.created_at));
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content:
        typeof r.content === "object" && r.content !== null && "text" in r.content
          ? String((r.content as { text: string }).text)
          : typeof r.content === "string"
            ? r.content
            : JSON.stringify(r.content),
    }));
}

export async function runLoop(p: RunLoopParams): Promise<RunLoopResult> {
  const events: TurnEvent[] = [];
  const budget = p.step_budget ?? DEFAULT_BUDGET;

  log.debug({
    module: "conversation",
    action: "loop.started",
    msg: "turn started",
    conversation_id: p.conversation_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    has_user_message: Boolean(p.user_message),
    step_budget: budget,
    model_override: p.model_override ?? null,
  });

  // Snapshot the tenant's monthly usage before the turn so we can
  // compute a turn_tokens delta at the end. Safe on test dbs — a
  // missing llm_usage row family returns 0.
  const usageBefore = await monthlyUsage(p.tenant_id, p.db).catch(() => 0);

  if (p.user_message) {
    await appendMessage(p.db, p.tenant_id, p.conversation_id, "user", { text: p.user_message });
    events.push({ type: "message", role: "user", content: { text: p.user_message } });
  }

  // Load current draft into memory for the duration of this turn.
  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);

  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: p.connector_id,
    workflow_id: p.workflow_id,
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
  };

  let lastToolFeedback: unknown = null;
  let status: RunLoopResult["status"] = "active";
  let committedWorkflowId: string | undefined;
  let pendingApprovalId: string | undefined;

  for (let step = 0; step < budget; step++) {
    // Ask the model for the next tool call.
    const lastUserText =
      typeof lastToolFeedback === "object" && lastToolFeedback !== null
        ? JSON.stringify(lastToolFeedback)
        : (p.user_message ?? "continue");
    const route = await resolveModelRoute(p.tenant_id, p.db);
    const effectiveModel = p.model_override ?? route.primary;
    // Load prior messages for real LLM providers. The mock provider
    // doesn't need them (it tracks state via plan cursors), but the
    // real provider needs the full conversation context.
    const priorTurns = await loadPriorTurns(p.db, p.conversation_id);
    // Build user_turns: prior conversation history + current turn.
    const currentTurn = {
      role: "user" as const,
      content: await buildConversationUserPrompt(p.conversation_id, lastUserText),
    };
    // If we have prior history, use it; otherwise just the current turn.
    const user_turns = priorTurns.length > 0 ? priorTurns : [currentTurn];
    // Only append the current turn if it's not already the last message
    // (it will be if appendMessage already persisted it above).
    if (priorTurns.length > 0 && priorTurns[priorTurns.length - 1]?.content !== lastUserText) {
      user_turns.push(currentTurn);
    }
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: p.tenant_id,
        flow: "converse",
        ...(p.connector_id ? { connector_id: p.connector_id } : {}),
        ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
        user_turns,
        max_tokens: route.context_cap,
        model: effectiveModel,
        ...(p.user_memory ? { user_memory: p.user_memory } : {}),
      },
      p.db,
    );
    // In tests the mock is the only provider, so we read the next
    // step directly via `nextConverseStep` to keep the plan cursor
    // source-of-truth inside the mock. The `callWithFallback` return
    // value carries the LLM's plain text response — we use it as the
    // assistant message when no tool plan is active (or completes).
    const llmResult = await callWithFallback<unknown>({ flow: "converse", route, prompt }, p.db);
    const planStep = getMockProvider().nextConverseStep(p.conversation_id);
    // No canned plan (production path) OR plan exhausted — emit the
    // LLM's text as a plain assistant message and exit the loop.
    if (planStep === null || isPlanDone(planStep)) {
      const text =
        typeof llmResult.result.text === "string" && llmResult.result.text.length > 0
          ? llmResult.result.text
          : "";
      if (text.length > 0) {
        await appendMessage(p.db, p.tenant_id, p.conversation_id, "assistant", { text });
        events.push({ type: "message", role: "assistant", content: { text } });
      }
      status = "active";
      break;
    }
    const parsed = parseToolStep(planStep);
    if (!parsed) {
      // Canned plan entry isn't a tool call — treat as assistant text.
      const content = planStep;
      await appendMessage(p.db, p.tenant_id, p.conversation_id, "assistant", content);
      events.push({ type: "message", role: "assistant", content });
      break;
    }

    const tool: ConversationTool | undefined = getTool(parsed.tool);
    events.push({ type: "tool_call", tool: parsed.tool, input: parsed.args });
    const [callRow] = await p.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        tool: parsed.tool,
        input: parsed.args,
        approval_required: parsed.tool === "request_human_approval",
      })
      .returning();

    log.conversation.tool.called({
      conversation_id: p.conversation_id,
      tool: parsed.tool,
      step,
    });

    if (!tool) {
      const output = { error: `unknown tool: ${parsed.tool}` };
      events.push({ type: "tool_result", tool: parsed.tool, output });
      if (callRow) {
        await p.db
          .update(conversationToolCalls)
          .set({ output: output as Record<string, unknown> })
          .where(eq(conversationToolCalls.id, callRow.id));
      }
      log.conversation.tool.failed({
        conversation_id: p.conversation_id,
        tool: parsed.tool,
        reason: "unknown_tool",
      });
      lastToolFeedback = output;
      continue;
    }

    let result: Awaited<ReturnType<ConversationTool["execute"]>>;
    const toolStartedAt = Date.now();
    try {
      result = await tool.execute(ctx, parsed.args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const output = { error: msg };
      events.push({ type: "tool_result", tool: parsed.tool, output });
      if (callRow) {
        await p.db
          .update(conversationToolCalls)
          .set({ output: output as Record<string, unknown> })
          .where(eq(conversationToolCalls.id, callRow.id));
      }
      log.conversation.tool.failed({
        conversation_id: p.conversation_id,
        tool: parsed.tool,
        error: msg,
        duration_ms: Date.now() - toolStartedAt,
      });
      lastToolFeedback = output;
      continue;
    }

    const dataSummary = summarizeToolData(result.data);
    const toolCtx = {
      conversation_id: p.conversation_id,
      tool: parsed.tool,
      ok: result.ok,
      paused: Boolean(result.pause),
      committed: Boolean(result.committed_workflow_id),
      duration_ms: Date.now() - toolStartedAt,
      ...dataSummary,
    };
    // `ok: false` from a tool is a soft failure (e.g. validation
    // rejection that feeds back into the loop) — surface it as
    // `tool.failed` so operators filtering failures catch both thrown
    // exceptions and soft-no results.
    if (result.ok) {
      log.conversation.tool.succeeded(toolCtx);
    } else {
      log.conversation.tool.failed(toolCtx);
    }

    if (callRow) {
      await p.db
        .update(conversationToolCalls)
        .set({ output: result.data as Record<string, unknown> })
        .where(eq(conversationToolCalls.id, callRow.id));
    }
    events.push({ type: "tool_result", tool: parsed.tool, output: result.data });

    // Persist a `tool` role message so the audit trail of the turn is
    // self-contained.
    await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", {
      tool: parsed.tool,
      output: result.data,
    });

    // Surface validation errors as their own event so the SSE stream
    // can highlight them.
    if (
      !result.ok &&
      typeof result.data === "object" &&
      result.data !== null &&
      Array.isArray((result.data as { errors?: unknown }).errors)
    ) {
      events.push({
        type: "validation_error",
        errors: (result.data as { errors: Array<{ path: string; message: string }> }).errors,
      });
    }

    lastToolFeedback = result.data;

    if (result.pause) {
      events.push({
        type: "approval_request",
        approval_id: result.pause.approval_id,
        kind: result.pause.kind,
        summary: result.pause.summary,
        ...(result.pause.diff !== undefined ? { diff: result.pause.diff } : {}),
        ...(result.pause.target !== undefined ? { target: result.pause.target } : {}),
      });
      log.conversation.approval.requested({
        conversation_id: p.conversation_id,
        approval_id: result.pause.approval_id,
        kind: result.pause.kind,
      });
      status = "awaiting_approval";
      pendingApprovalId = result.pause.approval_id;
      break;
    }
    if (result.committed_workflow_id) {
      events.push({ type: "committed", workflow_id: result.committed_workflow_id });
      events.push({ type: "completed", status: "committed" });
      log.conversation.completed({
        conversation_id: p.conversation_id,
        final_status: "committed",
        committed_workflow_id: result.committed_workflow_id,
        steps_taken: step + 1,
      });
      status = "committed";
      committedWorkflowId = result.committed_workflow_id;
      break;
    }
  }

  if (status === "active" && events.length > 0 && events[events.length - 1]?.type !== "message") {
    log.warn({
      module: "conversation",
      action: "loop.budget_exhausted",
      msg: "turn stopped without done/approval/commit (budget reached)",
      conversation_id: p.conversation_id,
      step_budget: budget,
    });
  }

  if (status === "active") {
    // Either we ran out of budget or the LLM returned done. Mark the
    // conversation back to active if it is not already committed /
    // awaiting_approval.
    const rows = await p.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, p.conversation_id))
      .limit(1);
    if (rows[0]?.status === "awaiting_approval") {
      status = "awaiting_approval";
    }
    events.push({ type: "completed", status: "active" });
  }

  // Attach usage to the final `completed` frame so the `sk` status
  // line and `/cost` slash can surface it. `turn_tokens` is the
  // monthly-ledger delta across this call; `remaining_monthly_budget`
  // is budget - usageAfter when the tenant has a budget.
  const usageAfter = await monthlyUsage(p.tenant_id, p.db).catch(() => usageBefore);
  const turnTokens = Math.max(0, usageAfter - usageBefore);
  // Resolve the model route once more to read the tenant's monthly
  // budget — resolveModelRoute caches the tenant row read.
  const route = await resolveModelRoute(p.tenant_id, p.db).catch(() => null);
  const remaining =
    route && typeof route.monthly_budget === "number"
      ? Math.max(0, route.monthly_budget - usageAfter)
      : null;
  // Replace every `completed` event we pushed with one that carries usage.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.type === "completed") {
      events[i] = {
        ...ev,
        usage: {
          turn_tokens: turnTokens,
          remaining_monthly_budget_tokens: remaining,
        },
      };
    }
  }

  const out: RunLoopResult = { events, status };
  if (committedWorkflowId) out.committed_workflow_id = committedWorkflowId;
  if (pendingApprovalId) out.pending_approval_id = pendingApprovalId;
  return out;
}
