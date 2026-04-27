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
import { log, logger } from "../../logging/logger.ts";
import { recordConversationToolCall } from "../../observability/instrumentation.ts";
import { resolveAttachments } from "../attachments.ts";
import { recordTransition } from "../confirmation.ts";
import { isDangerousTool } from "../dangerous-tools.ts";
import { createElicitation } from "../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import {
  buildPendingOutputForTool,
  type PermissionMode,
  prerequisitesForTool,
  resolveToolMode,
  type ToolPolicies,
} from "../tool-policies.ts";
import type { TurnEvent } from "../types.ts";
import { filterByAuthoringPalette } from "./authoring-palette.ts";
import { compileDescription } from "./describe.ts";
import { filterBySkillGate } from "./gated.ts";
import {
  type ConversationTool,
  listTools,
  type ToolContext,
  type ToolResult,
  type ToolResultPause,
} from "./index.ts";
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
  /**
   * Loop-breaker: per-turn counter of how many times each tool has
   * been invoked. Read-only tenant tools get a lower cap than draft /
   * write tools because repeated reads burn tokens without changing
   * state. This broke the repeated list_workflows loop observed in
   * session 64e36248 and the older commit/delete loop in 46ee7ec8.
   */
  toolInvocationCount: Map<string, number>;
  toolLastErrorHash: Map<string, string>;
  /**
   * Turn-level loop-warning counter. Incremented by the per-tool
   * loop-breaker on every short-circuit. Once this exceeds
   * `MAX_TURN_LOOP_WARNINGS`, the loop's `stopWhen` bails out so the
   * model does not keep getting re-driven into the same short-circuit
   * with nothing but `_loop_detected` artefacts to show for it.
   */
  totalLoopWarnings: number;
  /**
   * Running snapshot of the most recent assistant text surfaced by
   * `onStepFinish`. Used by the post-run fallback that synthesises a
   * visible message when the turn ended with no text but tool results.
   */
  lastAssistantText: string;
}

/** Max tolerated `loop_detected` short-circuits per turn before the outer loop stops. */
export const MAX_TURN_LOOP_WARNINGS = 2;

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
  pause?: ToolResultPause;
  committed_workflow_id?: string;
}

function wrapOne(
  inner: ConversationTool,
  ctx: ToolContext,
  signals: TurnSignals,
  events: TurnEvent[],
  db: Db,
  toolPolicies: ToolPolicies,
  permissionMode: PermissionMode | null,
  loadedSkills: ReadonlyArray<string>,
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
        // Skill prerequisite gate. Some tools (propose_step,
        // build_workflow, update_param, connect_steps) declare a
        // required skill in `tool-policies.ts#prerequisites`. If the
        // skill is not loaded, return a structured error instead of
        // running the tool — the model receives a clear "load
        // workflow-authoring first" hint and can recover in the next
        // turn. We surface the gate AFTER the model has chosen the
        // tool (rather than hiding it) so the failure mode teaches
        // the right next step instead of leaving the model guessing.
        const needed = prerequisitesForTool(inner.name);
        const missingSkills = needed.filter((slug) => !loadedSkills.includes(slug));
        if (missingSkills.length > 0) {
          return {
            ok: false,
            data: {
              error: `tool ${inner.name} requires skill(s) not yet loaded: ${missingSkills.join(", ")}. Call load_skill for each one before retrying.`,
              reason: "skill_prerequisites_unmet",
              tool: inner.name,
              missing_skills: missingSkills,
            },
          };
        }

        // Loop-breaker: short-circuit before doing any side effects
        // when the model has already called this tool too many times
        // in the current turn.
        const MAX_CALLS_PER_TURN = inner.category === "tenant_read" ? 3 : 5;
        const priorCount = signals.toolInvocationCount.get(inner.name) ?? 0;
        if (priorCount >= MAX_CALLS_PER_TURN) {
          signals.totalLoopWarnings += 1;
          const turnBudgetReached = signals.totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
          log.conversation.tool.called({
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            step: signals.step,
          });
          // Structured engine-log warning so the short-circuit is
          // visible in Docker / stdout without reading the response
          // tool_log events. Pre-fix: loop_detected only surfaced in
          // the CLI debug log (session 4e6696e3 fired 18× invisible to
          // the operator).
          logger.warn({
            module: "conversation",
            action: "tool.loop_detected",
            msg: turnBudgetReached
              ? "turn loop budget exhausted — ending turn"
              : "tool called too many times in one turn — aborting further calls",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            tool_count: priorCount,
            total_loop_warnings: signals.totalLoopWarnings,
            max_calls_per_turn: MAX_CALLS_PER_TURN,
            turn_budget_reached: turnBudgetReached,
          });
          events.push({
            type: "tool_log",
            call_id: "loop-detected",
            tool: inner.name,
            level: "warn",
            message: turnBudgetReached
              ? `tool.loop_detected: ${inner.name} called ${priorCount} times; turn-level loop budget exhausted (${signals.totalLoopWarnings}) — ending turn`
              : `tool.loop_detected: ${inner.name} called ${priorCount} times in one turn — aborting further calls`,
            ts: new Date().toISOString(),
          });
          return {
            ok: false,
            data: {
              error: turnBudgetReached
                ? `this tool has been invoked ${priorCount} times and the turn loop budget is exhausted — stop calling tools, summarise what you already know for the user, and end the turn`
                : `this tool has already been invoked ${priorCount} times in the current turn — change approach or ask the user for guidance instead of retrying with the same shape`,
              reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
              tool: inner.name,
            },
          };
        }
        signals.toolInvocationCount.set(inner.name, priorCount + 1);

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
          tool_call_id: toolCallId,
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
          permission_mode: permissionMode,
        });
        const policyMarker = (rawArgs as { __policy_confirmed?: boolean }).__policy_confirmed;
        const needsPreConfirmation =
          resolvedMode === "confirm_before_execution" &&
          inner.category === "tenant_write" &&
          !policyMarker;

        // yolo audit: when the resolver short-circuits a dangerous
        // tool because the operator armed yolo, emit a forensic-grade
        // log line so an operator can later answer "did anyone click
        // before this delete?". Lives next to the existing
        // `recordTransition` so the trail also surfaces in the
        // confirmation-state machine.
        const bypassedConfirmation = permissionMode === "yolo" && isDangerousTool(inner.name);
        if (bypassedConfirmation) {
          logger.warn({
            module: "tool",
            action: "tool.executed_yolo",
            msg: "dangerous tool executed under yolo — confirmation gate bypassed",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool_call_id: toolCallId,
            tool: inner.name,
            permission_mode: "yolo",
            bypassed_confirmation: true,
          });
        }

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
            data: {
              resolved_mode: resolvedMode,
              ...(permissionMode ? { permission_mode: permissionMode } : {}),
              ...(bypassedConfirmation ? { bypassed_confirmation: true } : {}),
            },
          });
        }

        // Policy-gated pre-execution confirmation: emit an elicitation
        // without invoking the tool. The operator's `respond` posts an
        // interaction_log entry; the model re-issues the same tool call
        // with `__policy_confirmed: true` on a subsequent turn.
        if (needsPreConfirmation) {
          // Same-turn dedupe — defense in depth against parallel tool
          // calls. Anthropic's `disableParallelToolUse` (loop.ts) keeps
          // this to a single tool_use per turn at the provider layer;
          // if a future provider or model variant slips a parallel call
          // through anyway, the second call refuses with a structured
          // error that points to the first elicitation. Without this,
          // a single user turn could stage N pending elicitations and
          // exhaust the loop-warning budget (session d34e5858 regression
          // — "starte mit übermorgen" produced 5 parallel run_workflow
          // pre-confirmations and surfaced the synthesised "I stopped
          // this turn early" fallback).
          if (signals.pendingElicitation) {
            const dupOutput = {
              error: "duplicate_pending_elicitation_in_turn",
              note: "Another tool call in this turn already staged an ask_user_confirm. Wait for the user to resolve that one, then re-issue this call after the user confirms.",
              existing_elicitation_id: signals.pendingElicitation.elicitation_id,
              existing_tool: signals.pendingElicitation.tool_name,
            };
            await updateToolCallOutput(db, toolCallId, dupOutput);
            events.push({
              type: "tool_result",
              call_id: toolCallId,
              tool: inner.name,
              output: dupOutput,
            });
            recordConversationToolCall({
              category: inner.category,
              tool: inner.name,
              outcome: "denied",
              duration_ms: Date.now() - startedAt,
            });
            return { ok: false, data: dupOutput };
          }
          // Structured pending-output preview so the confirm UI shows
          // first-class fields (target id, environment, key shape)
          // instead of a raw arg blob the user has to parse.
          const pendingOutput = buildPendingOutputForTool(inner.name, rawArgs);
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
                ...(pendingOutput ? { pending_output: pendingOutput } : {}),
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
            ...(pendingOutput ? { pending_output: pendingOutput } : {}),
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
        //
        // For structured `ok: false` results that carry `error_code` +
        // `message` instead of `data`, build a normalised output object
        // so the model always sees a consistent envelope.
        const resultPayload: unknown = result.ok
          ? result.data
          : result.data !== undefined
            ? result.data
            : {
                ok: false,
                ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
                ...(result.message !== undefined ? { message: result.message } : {}),
                ...(result.details !== undefined ? { details: result.details } : {}),
                ...(result.next_best_actions !== undefined
                  ? { next_best_actions: result.next_best_actions }
                  : {}),
              };
        await updateToolCallOutput(db, toolCallId, resultPayload);
        const truncated = truncateForLlm(resultPayload);
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
            : resultPayload,
        });

        const dataSummary = summarizeToolData(resultPayload);
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

        // Track the last error shape so repeated identical failures
        // can break out of a loop. A "shape" is the (reason, error)
        // pair — same reason + same first ~80 chars of error counts
        // as a repeat.
        if (result.ok) {
          signals.toolLastErrorHash.delete(inner.name);
        } else {
          const errObj = (resultPayload ?? {}) as Record<string, unknown>;
          const reason =
            typeof errObj.reason === "string"
              ? errObj.reason
              : typeof errObj.error_code === "string"
                ? errObj.error_code
                : "";
          const err =
            typeof errObj.error === "string"
              ? errObj.error
              : typeof errObj.message === "string"
                ? errObj.message
                : Array.isArray(errObj.errors)
                  ? JSON.stringify(errObj.errors).slice(0, 120)
                  : "";
          const shape = `${reason}|${err.slice(0, 120)}`;
          signals.toolLastErrorHash.set(inner.name, shape);
        }

        // Mirror the old loop: a `tool` role message keeps the audit
        // trail of the turn self-contained in `conversation_messages`.
        // The persisted message carries the full output (not truncated)
        // for faithful replay.
        await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
          tool: inner.name,
          output: resultPayload,
        });

        if (
          !result.ok &&
          typeof resultPayload === "object" &&
          resultPayload !== null &&
          Array.isArray((resultPayload as { errors?: unknown }).errors)
        ) {
          events.push({
            type: "validation_error",
            errors: (resultPayload as { errors: Array<{ path: string; message: string }> }).errors,
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
          // Tool-emitted pause may carry its own pending_output; if
          // not, derive one from the wrapping tool's policy hook so
          // the confirm UI gets a structured preview either way.
          const pausePending =
            (inputPayload && typeof inputPayload === "object"
              ? ((inputPayload as { pending_output?: Record<string, unknown> }).pending_output ??
                null)
              : null) ?? buildPendingOutputForTool(inner.name, rawArgs);
          events.push({
            type: "elicit_request",
            elicitation_id: result.pause.elicitation_id,
            tool_name: result.pause.tool_name,
            summary: result.pause.summary,
            input: inputPayload,
            ...(pausePending ? { pending_output: pausePending } : {}),
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
          data: resultPayload,
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
  permissionMode: PermissionMode | null = null,
): Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> {
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  // Apply skill-gate: tools whose `requires_skill` isn't in loadedSkills
  // are hidden from the model until the matching `load_skill` call.
  const loadedSkillSet = new Set(loadedSkills);
  const visibleTools = filterByAuthoringPalette(
    filterBySkillGate(listTools(), loadedSkills),
    ctx.getDraft(),
    loadedSkillSet,
  );
  for (const t of visibleTools) {
    out[t.name] = wrapOne(t, ctx, signals, events, db, toolPolicies, permissionMode, loadedSkills);
  }
  return out;
}
