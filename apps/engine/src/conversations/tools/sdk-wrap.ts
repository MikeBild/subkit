// Wrap every in-repo ConversationTool in the AI SDK's `tool()` factory.
//
// The wrapped tool's `execute` performs the exact side-effect sequence
// the old hand-rolled loop did (loop.ts prior to A5): insert the
// `conversation_tool_calls` row, emit a `tool_call` event, log
// `conversation.tool.called`, run the inner tool, update the row with
// the output, emit `tool_result` + optional `validation_error`, and
// stash any pause / committed markers on the shared `TurnSignals`.
//
// Pause and commit are NOT thrown — the SDK must see a real tool-result
// so the model can plan its next step. The loop halts via the
// `stopWhen` conditions evaluated between steps.

import type { z } from "@hono/zod-openapi";
import { type Tool, tool } from "ai";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import type { ApprovalKind, TurnEvent } from "../types.ts";
import { type ConversationTool, listTools, type ToolContext, type ToolResult } from "./index.ts";

export interface TurnSignals {
  pendingApproval?: {
    approval_id: string;
    kind: ApprovalKind;
    summary: string;
    diff?: unknown;
    target?: unknown;
  };
  committed?: {
    workflow_id: string;
  };
  /** Tool-call step counter used only for log correlation. */
  step: number;
  /**
   * Per-turn promise-chain mutex. The SDK executes parallel tool calls
   * within a single step via `Promise.all`, but our tools mutate
   * shared draft state (`ctx.setDraft`) and emit events in a strict
   * ordering. Queueing every wrapper's body on this chain keeps
   * draft mutations serial and event order deterministic, at the cost
   * of losing parallel speedup (acceptable — tool bodies are short
   * and almost always DB-bound).
   */
  toolChain: Promise<void>;
}

/**
 * Attach summary fields so `conversation.tool.succeeded/failed` logs
 * carry at least some shape context regardless of which tool emitted.
 */
function summarizeToolData(data: unknown): Record<string, number | string | boolean> {
  if (data === null || data === undefined) return {};
  if (Array.isArray(data)) return { data_length: data.length };
  if (typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const out: Record<string, number | string | boolean> = {};
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

/**
 * Payload the SDK feeds back to the model as the tool-result. Keeps
 * the existing `{ok, data, ...}` envelope so models already trained on
 * our tool palette see an identical shape.
 */
interface WrappedToolOutput {
  ok: boolean;
  data: unknown;
  pause?: ToolResult["pause"];
  committed_workflow_id?: string;
}

function wrapOne(
  inner: ConversationTool,
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  // Cast the Zod-openapi schema to the SDK's `z.ZodType` shape — the
  // two packages ship their own Zod re-exports and the variances do not
  // reconcile at the type level, but the runtime `parse` contract is
  // identical.
  const inputSchema = inner.inputSchema as unknown as z.ZodType<Record<string, unknown>>;
  return tool<Record<string, unknown>, WrappedToolOutput>({
    description: inner.description,
    inputSchema,
    async execute(rawArgs: Record<string, unknown>): Promise<WrappedToolOutput> {
      // Serialize against other tool executions in this turn — see
      // TurnSignals.toolChain for rationale.
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      const executeBody = async (): Promise<WrappedToolOutput> => {
        const step = signals.step++;
        const startedAt = Date.now();
        const toolCallId = await insertToolCall(db, {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tool: inner.name,
          input: rawArgs,
          approval_required: inner.name === "request_human_approval",
        });
        events.push({ type: "tool_call", tool: inner.name, input: rawArgs });
        log.conversation.tool.called({
          conversation_id: ctx.conversation_id,
          tool: inner.name,
          step,
        });

        let result: ToolResult;
        try {
          result = await inner.execute(ctx, rawArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const output = { error: msg };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({ type: "tool_result", tool: inner.name, output });
          log.conversation.tool.failed({
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            error: msg,
            duration_ms: Date.now() - startedAt,
          });
          return { ok: false, data: output };
        }

        await updateToolCallOutput(db, toolCallId, result.data);
        events.push({ type: "tool_result", tool: inner.name, output: result.data });

        const dataSummary = summarizeToolData(result.data);
        const logCtx = {
          conversation_id: ctx.conversation_id,
          tool: inner.name,
          ok: result.ok,
          paused: Boolean(result.pause),
          committed: Boolean(result.committed_workflow_id),
          duration_ms: Date.now() - startedAt,
          ...dataSummary,
        };
        if (result.ok) log.conversation.tool.succeeded(logCtx);
        else log.conversation.tool.failed(logCtx);

        // Mirror the old loop: a `tool` role message keeps the audit
        // trail of the turn self-contained in `conversation_messages`.
        await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
          tool: inner.name,
          output: result.data,
        });

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
            conversation_id: ctx.conversation_id,
            approval_id: result.pause.approval_id,
            kind: result.pause.kind,
          });
          signals.pendingApproval = {
            approval_id: result.pause.approval_id,
            kind: result.pause.kind,
            summary: result.pause.summary,
            ...(result.pause.diff !== undefined ? { diff: result.pause.diff } : {}),
            ...(result.pause.target !== undefined ? { target: result.pause.target } : {}),
          };
        }

        if (result.committed_workflow_id) {
          events.push({ type: "committed", workflow_id: result.committed_workflow_id });
          log.conversation.completed({
            conversation_id: ctx.conversation_id,
            final_status: "committed",
            committed_workflow_id: result.committed_workflow_id,
            steps_taken: step + 1,
          });
          signals.committed = { workflow_id: result.committed_workflow_id };
        }

        return {
          ok: result.ok,
          data: result.data,
          ...(result.pause ? { pause: result.pause } : {}),
          ...(result.committed_workflow_id
            ? { committed_workflow_id: result.committed_workflow_id }
            : {}),
        };
      };

      try {
        return await executeBody();
      } finally {
        release();
      }
    },
  });
}

/**
 * Build the SDK `toolSet` for one `runLoop` invocation. Each wrapped
 * tool closes over `ctx`, `signals`, and `events` so side effects land
 * in the same sink the loop returns to callers.
 */
export function wrapTools(
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
): Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> {
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  for (const t of listTools()) {
    out[t.name] = wrapOne(t, ctx, signals, events, db);
  }
  return out;
}
