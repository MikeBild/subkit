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

import { z } from "@hono/zod-openapi";
import { type Tool, tool } from "ai";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { recordConversationToolCall } from "../../observability/instrumentation.ts";
import { resolveAttachments } from "../attachments.ts";
import { recordTransition } from "../confirmation.ts";
import { createElicitation } from "../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import { resolveToolMode, type ToolPolicies } from "../tool-policies.ts";
import type { TurnEvent } from "../types.ts";
import { compileDescription } from "./describe.ts";
import { filterBySkillGate } from "./gated.ts";
import { type ConversationTool, listTools, type ToolContext, type ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

export interface TurnSignals {
  pendingElicitation?: {
    elicitation_id: string;
    tool_name: string;
    kind?: string;
    summary: string;
    input?: unknown;
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
  /**
   * Per-step buffer of child rows created by tool wrappers since the
   * last `onStepFinish`. The loop's onStepFinish back-fills
   * `parent_message_id` on these rows after inserting the step's
   * assistant message, so the read path can interleave them
   * deterministically under that message in the timeline. Reset to
   * empty arrays after every step.
   */
  pendingChildToolCallIds: string[];
  pendingChildElicitationIds: string[];
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
  toolPolicies: ToolPolicies,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  // Cast the Zod-openapi schema to the SDK's `z.ZodType` shape — the
  // two packages ship their own Zod re-exports and the variances do not
  // reconcile at the type level, but the runtime `parse` contract is
  // identical.
  const baseInputSchema = inner.inputSchema as unknown as z.ZodType<Record<string, unknown>> & {
    extend?: (shape: Record<string, z.ZodTypeAny>) => z.ZodType<Record<string, unknown>>;
  };
  const inputSchema =
    typeof baseInputSchema.extend === "function"
      ? baseInputSchema.extend({ __policy_confirmed: z.boolean().optional() })
      : baseInputSchema;
  return tool<Record<string, unknown>, WrappedToolOutput>({
    description: compileDescription(inner),
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
          approval_required: inner.name.startsWith("ask_user_"),
        });
        signals.pendingChildToolCallIds.push(toolCallId);
        events.push({
          type: "tool_call_start",
          call_id: toolCallId,
          tool: inner.name,
          input_partial: rawArgs,
        });
        events.push({ type: "tool_call_end", call_id: toolCallId, input: rawArgs });
        log.conversation.tool.called({
          conversation_id: ctx.conversation_id,
          tool: inner.name,
          step,
        });

        // Per-call correlated log callback. Tools that want to emit
        // progress updates during long-running work call
        // `ctx.onLog("info", "...")` — each emission becomes a
        // `tool_log` TurnEvent the client can render live.
        const perCallCtx: ToolContext = {
          ...ctx,
          onLog: (level, message) => {
            events.push({
              type: "tool_log",
              call_id: toolCallId,
              tool: inner.name,
              level,
              message,
              ts: new Date().toISOString(),
            });
          },
        };

        // Resolve the effective execution mode (per-conversation
        // override → dynamic compute-from-input → category default).
        // The resolved mode is recorded in the interaction_log's
        // `proposed` transition so operators / observability see it,
        // and a `policy_confirm_required` elicit_request is emitted
        // when the mode demands confirmation before execution.
        const resolvedMode = resolveToolMode({
          tool: inner.name,
          category: inner.category,
          input: rawArgs,
          overrides: toolPolicies,
        });
        const policyMarker = (rawArgs as { __policy_confirmed?: boolean }).__policy_confirmed;
        const needsPreConfirmation =
          resolvedMode === "confirm_before_execution" &&
          inner.category === "tenant_write" &&
          !policyMarker;

        // Confirmation-state machine entry: tenant_write tools stage a
        // `proposed` state before execution. On success we transition
        // to `confirmed`, on failure to `declined`. Read-only tools
        // skip this entirely — the state columns stay null.
        if (inner.category === "tenant_write") {
          await recordTransition(db, {
            tool_call_id: toolCallId,
            tenant_id: ctx.tenant_id,
            to_state: "proposed",
            actor_id: ctx.actor_id,
            tool: inner.name,
            data: { resolved_mode: resolvedMode },
          });
        }

        // Policy-gated pre-execution confirmation: emit an elicitation
        // without invoking the tool. The operator's `respond` posts an
        // interaction_log entry; the model re-issues the same tool call
        // with `__policy_confirmed: true` on a subsequent turn.
        if (needsPreConfirmation) {
          const elicitation = await createElicitation(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              tool_call_id: toolCallId,
              tool_name: "ask_user_confirm",
              summary: `Confirm ${inner.name} (policy: ${resolvedMode})`,
              input: {
                kind: "external_write",
                question: `Policy requires confirmation before running ${inner.name}. Proceed?`,
                target: { tool: inner.name, args: rawArgs },
              },
              actor_id: ctx.actor_id,
            },
            db,
          );
          signals.pendingChildElicitationIds.push(elicitation.id);
          const output = {
            pending: true,
            policy_mode: resolvedMode,
            note: "policy_confirm_required — operator must confirm before the tool executes. Re-issue the same call with __policy_confirmed: true after receiving confirmation.",
          };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output,
          });
          events.push({
            type: "elicit_request",
            elicitation_id: elicitation.id,
            tool_name: "ask_user_confirm",
            summary: elicitation.summary,
            input: elicitation.input,
          });
          signals.pendingElicitation = {
            elicitation_id: elicitation.id,
            tool_name: "ask_user_confirm",
            kind: "external_write",
            summary: `Confirm ${inner.name}`,
            input: elicitation.input,
          };
          recordConversationToolCall({
            category: inner.category,
            tool: inner.name,
            outcome: "denied",
            duration_ms: Date.now() - startedAt,
          });
          return {
            ok: false,
            data: output,
            pause: {
              elicitation_id: elicitation.id,
              tool_name: "ask_user_confirm",
              summary: `Confirm ${inner.name}`,
              kind: "external_write",
              input: {
                kind: "external_write",
                target: { tool: inner.name, args: rawArgs },
              },
            },
          };
        }

        // Resolve @attachment:<slug> references inside rawArgs before
        // handing them to the tool. Any unresolved slug short-circuits
        // the execution with a typed error — the tool never sees the
        // marker, the audit row reflects the failure mode clearly.
        const attachmentResolved = await resolveAttachments(rawArgs, {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          db,
        });
        if (attachmentResolved.unresolved.length > 0) {
          const output: Record<string, unknown> = {
            ok: false,
            persistence: "none",
            error: {
              code: "attachment_not_found",
              message: "one or more @attachment:<slug> references could not be resolved",
              details: { unresolved: attachmentResolved.unresolved },
            },
          };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output,
          });
          release();
          return { ok: false, data: output };
        }
        const resolvedArgs = attachmentResolved.value as Record<string, unknown>;

        let result: ToolResult;
        try {
          result = await inner.execute(perCallCtx, resolvedArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const output = { error: msg };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output,
          });
          if (inner.category === "tenant_write") {
            await recordTransition(db, {
              tool_call_id: toolCallId,
              tenant_id: ctx.tenant_id,
              to_state: "declined",
              actor_id: ctx.actor_id,
              tool: inner.name,
              data: { reason: msg, stage: "execute_threw" },
            });
          }
          recordConversationToolCall({
            category: inner.category,
            tool: inner.name,
            outcome: "error",
            duration_ms: Date.now() - startedAt,
          });
          log.conversation.tool.failed({
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            error: msg,
            duration_ms: Date.now() - startedAt,
          });
          return { ok: false, data: output };
        }
        if (inner.category === "tenant_write") {
          await recordTransition(db, {
            tool_call_id: toolCallId,
            tenant_id: ctx.tenant_id,
            to_state: result.ok ? "confirmed" : "declined",
            actor_id: ctx.actor_id,
            tool: inner.name,
            ...(result.ok ? {} : { data: { reason: "tool returned ok=false" } }),
          });
        }

        // Persist the FULL output to the conversation_tool_calls row
        // (for audit / replay), but feed only a TRUNCATED view back to
        // the model so a 200-row list doesn't blow subsequent context
        // budgets. `raw_ref` carries a handle the model can fetch via
        // `get_raw_result` when it actually needs the rest.
        await updateToolCallOutput(db, toolCallId, result.data);
        const truncated = truncateForLlm(result.data);
        events.push({
          type: "tool_result",
          call_id: toolCallId,
          tool: inner.name,
          output: truncated.truncated
            ? {
                ...(truncated.data as Record<string, unknown>),
                _truncated: true,
                _raw_ref: truncated.raw_ref,
                _note: truncated.note,
              }
            : result.data,
        });

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
        recordConversationToolCall({
          category: inner.category,
          tool: inner.name,
          outcome: result.ok ? "ok" : "error",
          duration_ms: Date.now() - startedAt,
        });

        // Mirror the old loop: a `tool` role message keeps the audit
        // trail of the turn self-contained in `conversation_messages`.
        // The persisted message carries the full output (not truncated)
        // for faithful replay.
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
          // Prefer the full input payload; fall back to reconstructing
          // from legacy {kind, diff, target} fields.
          const inputPayload =
            result.pause.input !== undefined
              ? result.pause.input
              : {
                  ...(result.pause.kind !== undefined ? { kind: result.pause.kind } : {}),
                  ...(result.pause.diff !== undefined ? { diff: result.pause.diff } : {}),
                  ...(result.pause.target !== undefined ? { target: result.pause.target } : {}),
                };
          signals.pendingChildElicitationIds.push(result.pause.elicitation_id);
          events.push({
            type: "elicit_request",
            elicitation_id: result.pause.elicitation_id,
            tool_name: result.pause.tool_name,
            summary: result.pause.summary,
            input: inputPayload,
          });
          log.conversation.approval.requested({
            conversation_id: ctx.conversation_id,
            approval_id: result.pause.elicitation_id,
            kind: result.pause.kind ?? result.pause.tool_name,
          });
          signals.pendingElicitation = {
            elicitation_id: result.pause.elicitation_id,
            tool_name: result.pause.tool_name,
            summary: result.pause.summary,
            input: inputPayload,
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
  loadedSkills: ReadonlyArray<string> = [],
  toolPolicies: ToolPolicies = {},
): Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> {
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  // Apply skill-gate: tools whose `requires_skill` isn't in loadedSkills
  // are hidden from the model until the matching `load_skill` call.
  for (const t of filterBySkillGate(listTools(), loadedSkills)) {
    out[t.name] = wrapOne(t, ctx, signals, events, db, toolPolicies);
  }
  return out;
}
