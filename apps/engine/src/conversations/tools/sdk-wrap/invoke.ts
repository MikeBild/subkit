// Per-tool wrapping logic. Each in-repo `ConversationTool` becomes a
// Vercel-AI-SDK `Tool` whose `execute` performs the side-effect
// sequence the old hand-rolled loop did:
//
//   1. insert the `conversation_tool_calls` row
//   2. emit `tool_call_start` / `tool_call_end` events
//   3. log `conversation.tool.called`
//   4. evaluate policy gates / dedupe / loop-breakers
//   5. run the inner tool
//   6. update the row with the output
//   7. emit `tool_result` + optional `validation_error` / `elicit_request`
//   8. stash any pause / committed markers on the shared `TurnSignals`
//
// Pause and commit are NOT thrown — the SDK must see a real tool-result
// so the model can plan its next step. The loop halts via the
// `stopWhen` conditions evaluated between steps.

import { z } from "@hono/zod-openapi";
import { type Tool, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
} from "../../../db/schema/index.ts";
import { log, logger } from "../../../logging/logger.ts";
import {
  recordConversationToolCall,
  recordToolCircuitOpen,
} from "../../../observability/instrumentation.ts";
import { startToolSpan } from "../../../observability/langfuse-spans.ts";
import { FileNotFoundError, type ResolvedFile, walkAndResolve } from "../../attachments.ts";
import { recordTransition } from "../../confirmation.ts";
import { isDangerousTool } from "../../dangerous-tools.ts";
import { createDraftSnapshot } from "../../draft-checkpoints.ts";
import { createElicitation } from "../../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import { findPriorSaveWorkflowApproval } from "../../persistence/save-workflow-approval.ts";
import { resolveScopeFactsForConversation } from "../../scope-facts.ts";
import { autoloadForToolCall, loadActivationCatalog } from "../../skill-autoload.ts";
import { computeLineDiff } from "../../text-line-diff.ts";
import {
  buildPendingOutputForTool,
  type PermissionMode,
  prerequisitesForTool,
  resolveToolMode,
  type ToolPolicies,
} from "../../tool-policies.ts";
import type { TurnEvent } from "../../types.ts";
import { compileDescription } from "../describe.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../index.ts";
import { truncateForLlm } from "../truncate.ts";
import { buildCapAlternatives } from "./error-recovery-hints.ts";
import {
  buildPolicyGateCommitIntent,
  confirmationMetadataForTool,
  extractText,
  isAffirmation,
  mapToolToCommitIntentKind,
  proseConfirmationApplies,
  REVIEW_AFTER_EXECUTION_KIND,
  referencesProseConfirmation,
  summarizeToolData,
  topLevelElicitationKindForTool,
} from "./policy-helpers.ts";
import {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_TURN_LOOP_WARNINGS,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
  type TurnSignals,
  type WrappedToolOutput,
} from "./state.ts";

// The `inputExamples` SDK channel was emitted from this helper
// alongside the tool's `<example>` description block. AI SDK 6 /
// Anthropic now strict-validates each example against the projected
// JSON Schema, and the projection reflexively seals every object with
// `additionalProperties: false` (including `z.record(...)` values,
// which legitimately accept any string key). That mismatch breaks
// every conversation turn with
// `tools.N.custom: Example at index 0 is invalid: False schema does
// not allow <value>`. The model already reads the same example from
// the `<example>` block compileDescription appends to the description,
// so the `inputExamples` channel is redundant for us today and the
// safe move is to stop emitting it. We keep the helper (returning an
// empty object) so the call-site stays one statement; a future fix in
// either zod-to-json-schema's record handling or the SDK's projection
// pass can flip this back on after the regression test below proves
// every tool's example_input survives the strict JSON-Schema
// validation. Exported for the test suite (propose-skill-strict.test.ts).
export function toInputExamples(
  _example: Readonly<Record<string, unknown>> | undefined,
): { inputExamples: Array<{ input: Record<string, unknown> }> } | Record<string, never> {
  return {};
}

export function wrapOne(
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
    // Opt-in provider-native strict mode + inputExamples.
    ...(inner.strict ? { strict: true as const } : {}),
    // toInputExamples is intentionally a no-op since v4.6.0 — see the
    // helper's header for the AI SDK 6 / Anthropic strict-validation
    // regression that motivated suppressing this channel. The model
    // still receives the example via the `<example>` block
    // compileDescription appends to the description above.
    ...toInputExamples(inner.example_input),
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

        // Global consecutive-failures cap (mirrors reference impl's
        // "no more than 5 failed tool calls in a row" rule). Checked
        // before the per-tool cap because it overrides — when the
        // model has hit the cap on ANY mix of tools, the next dispatch
        // returns a structured "ask the user" envelope instead of
        // running the tool. The model is then forced to emit
        // `ask_user_choice` / `ask_user_text` to break the loop.
        // Exception: ask_user_* tools always run (those are how the
        // model recovers). Read-only inspection tools also pass so the
        // model can call inspect_workflow to read scope shape after
        // the cap fires.
        const isAskUser = inner.name.startsWith("ask_user_");
        const isInspect =
          inner.name.startsWith("inspect_") || inner.name === "diagnose_latest_execution";
        if (!isAskUser && !isInspect && signals.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          recordToolCircuitOpen({
            tool: inner.name,
            reason: "consecutive_failures_cap",
          });
          logger.warn({
            module: "conversation_tool",
            action: "tool.consecutive_failures_block",
            msg: "global consecutive-failures cap reached — short-circuiting until model asks the user",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            consecutive_failures: signals.consecutiveFailures,
          });
          const alternatives = buildCapAlternatives(signals.toolLastErrorHash);
          return {
            ok: false,
            data: {
              error_code: "consecutive_failures_cap",
              message: `${signals.consecutiveFailures} tool calls have failed in a row — stop patching and emit ask_user_choice with concrete options derived from the most recent failure (e.g. "commit anyway", "revert the last patch", "hand-edit the workflow JSON"). The cap resets on the first successful tool call.${alternatives}`,
              reason: "consecutive_failures_cap",
              consecutive_failures: signals.consecutiveFailures,
              next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
            },
          };
        }

        // Adaptive loop-breaker. Reference impl uses a single global
        // `stepCountIs(50)` and trusts the model — no per-tool cap.
        // Subkit's per-tool counters fired even on legitimate
        // incremental authoring (session a128deba 15:13:16:
        // propose_step capped mid-build of a 4-step workflow).
        //
        // Adaptive shape:
        //   - tenant_read tools have NO repeat cap. Reads are
        //     idempotent — the model needs them.
        //   - draft_write / tenant_write tools trip ONLY when the
        //     SAME args are submitted REPEAT_THRESHOLD times in a
        //     row. Five propose_step calls with five different step
        //     ids = fine. Three propose_step calls with the same
        //     args = repair spiral, halt.
        //   - The global step ceiling lives in the outer loop's
        //     `stopWhen: stepCountIs(N)` (matches reference's
        //     stopWhen contract). Per-tool repeat detection here
        //     short-circuits before that ceiling fires.
        const REPEAT_THRESHOLD = 3;
        // Recursive stable serialiser: sort object keys at every
        // depth so { a: { x: 1, y: 2 } } and { a: { y: 2, x: 1 } }
        // hash the same. JSON.stringify's replacer-array only
        // applies at the top level and silently drops keys at
        // deeper levels — we need a deep-stable hash.
        const stableStringify = (v: unknown): string => {
          if (v === null || typeof v !== "object") return JSON.stringify(v);
          if (Array.isArray(v)) {
            return `[${v.map(stableStringify).join(",")}]`;
          }
          const keys = Object.keys(v as Record<string, unknown>).sort();
          return `{${keys
            .map(
              (k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`;
        };
        const argsHash = (() => {
          try {
            return stableStringify(rawArgs);
          } catch {
            return "";
          }
        })();
        // Exempt-by-name list: tools whose meaningful state lives
        // in the conversation's DRAFT, not in args. Re-running them
        // with identical args after editing the draft is the
        // canonical "iterate the workflow" pattern — flagging it
        // as a repeat spiral is a false positive.
        // Pre-fix (session 8d152b9f 16:00:59): dry_run_workflow
        // capped after 3 previews of the SAME draft args even
        // though each preview ran against a DIFFERENT draft state.
        // `validate_draft` used to live here too. It was removed once
        // the authoring-context-block started inlining the current
        // validation state on every turn (apps/engine/src/llm/core/
        // authoring-context-block.ts#renderValidationStateLines): the
        // LLM now sees errors continuously and never needs to repeat
        // the same `validate_draft({})` call to re-check. If it does,
        // that's the loop spiral the repeat cap is meant to catch.
        const REPEAT_EXEMPT_TOOLS = new Set<string>([
          "dry_run_workflow",
          "dry_run_step",
          "dry_run_transform",
          "validate_connector_draft",
          "inspect_workflow_draft",
          "inspect_workflow",
          "inspect_connector_draft",
          "inspect_authoring_context",
          "inspect_execution_step",
          "list_skills",
          "load_skill",
          "search_docs",
          "search_knowledge",
        ]);
        const isReadOnly = inner.category === "tenant_read" || REPEAT_EXEMPT_TOOLS.has(inner.name);
        const repeatTracker = signals.toolArgsRepeat.get(inner.name);
        let repeatCount = 0;
        if (!isReadOnly && argsHash) {
          if (repeatTracker?.hash === argsHash) {
            repeatCount = repeatTracker.count + 1;
          } else {
            repeatCount = 1;
          }
          signals.toolArgsRepeat.set(inner.name, { hash: argsHash, count: repeatCount });
        }
        const priorCount = signals.toolInvocationCount.get(inner.name) ?? 0;
        const tripped = !isReadOnly && repeatCount >= REPEAT_THRESHOLD;
        if (tripped) {
          signals.totalLoopWarnings += 1;
          const turnBudgetReached = signals.totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
          log.conversation.tool.called({
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            step: signals.step,
          });
          // Structured engine-log warning so the short-circuit is
          // visible in Docker / stdout without reading the response
          // tool_log events.
          recordToolCircuitOpen({
            tool: inner.name,
            reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
          });
          logger.warn({
            module: "conversation",
            action: "tool.loop_detected",
            msg: turnBudgetReached
              ? "turn loop budget exhausted — ending turn"
              : "same args submitted to a write tool 3× in a row — aborting further calls",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            tool_count: priorCount,
            repeat_count: repeatCount,
            args_hash: argsHash.slice(0, 64),
            total_loop_warnings: signals.totalLoopWarnings,
            repeat_threshold: REPEAT_THRESHOLD,
            turn_budget_reached: turnBudgetReached,
          });
          events.push({
            type: "tool_log",
            call_id: "loop-detected",
            tool: inner.name,
            level: "warn",
            message: turnBudgetReached
              ? `tool.loop_detected: ${inner.name} repeated identical args ${repeatCount}×; turn-level loop budget exhausted (${signals.totalLoopWarnings}) — ending turn`
              : `tool.loop_detected: ${inner.name} called with identical args ${repeatCount}× in a row — change approach or ask the user`,
            ts: new Date().toISOString(),
          });
          return {
            ok: false,
            data: {
              error_code: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
              message: turnBudgetReached
                ? `this turn called tools ${signals.totalLoopWarnings}× past the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`
                : `${inner.name} has been called with identical args ${repeatCount}× in a row in this turn — change the args or stop and ask the user via ask_user_choice / ask_user_text. Do NOT retry with the SAME shape.`,
              reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
              tool: inner.name,
              repeat_count: repeatCount,
              next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
            },
          };
        }
        signals.toolInvocationCount.set(inner.name, priorCount + 1);

        const step = signals.step++;
        const startedAt = Date.now();
        const ensureAssistantMessageAnchor = async (): Promise<string> => {
          if (signals.assistantMessageId) return signals.assistantMessageId;
          const messageId = await appendMessage(
            db,
            ctx.tenant_id,
            ctx.conversation_id,
            "assistant",
            {},
          );
          signals.assistantMessageId = messageId;
          return messageId;
        };
        const assistantMessageId = await ensureAssistantMessageAnchor();
        const toolCallId = await insertToolCall(db, {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          parent_message_id: assistantMessageId,
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
          parent_message_id: assistantMessageId,
        });
        events.push({
          type: "tool_call_end",
          call_id: toolCallId,
          input: rawArgs,
          parent_message_id: assistantMessageId,
        });
        // Single-line activity ticker: tell the operator WHAT the
        // engine is doing right now. The transcript already shows the
        // tool-call card; this just keeps the ticker accurate when
        // the card scrolls out of view. Throttled in EventSink.
        events.push({
          type: "activity",
          phase: "tool",
          label: inner.name,
          tool_name: inner.name,
          call_id: toolCallId,
        });
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
          assistant_message_id: assistantMessageId,
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
          // Inline diff emitter — tools that mutate the draft call this
          // with canonical before/after JSON; we compute the unified
          // line-diff once on the engine side and ship pre-built hunks
          // over the wire. Mirrors codex's `PatchHistoryCell` pattern.
          emitDiff: ({ title, language, before, after }) => {
            try {
              const hunks = computeLineDiff(before, after, { context: 3 });
              if (hunks.length === 0) return;
              events.push({ type: "diff", title, language, hunks });
            } catch {
              // Best-effort — never block the tool on a diff failure.
            }
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
        // Cross-prompt dedup: if the LLM has *already* surfaced an
        // `ask_user_confirm` for this same tool intent in the recent
        // conversation history (and the user said yes), skip the
        // policy-gate elicitation — that would otherwise produce the
        // back-to-back "yes / approve" double-prompt the operator sees
        // when committing a workflow draft. Maps the current tool to
        // the elicitation `commit_intent.kind` the LLM uses; resolves
        // the most recent matching elicitation; skips the gate when
        // that elicitation was confirmed within the last 5 minutes.
        const intentKindForCurrentTool = mapToolToCommitIntentKind(inner.name);
        // Dedup decision: "did the operator already confirm THIS tool's
        // intent recently?" — if so, skip the policy-gate pre-confirm.
        //
        // For `save_workflow_draft` the dedup MUST use the exact same
        // predicate the commit gate authorizes on
        // (`findPriorSaveWorkflowApproval`, keyed on
        // `input.commit_intent.kind`). If the two diverged, the policy
        // gate could skip the pre-confirm on an approval the commit gate
        // then rejects (the production dead-end), or pause redundantly
        // on an approval the commit gate would accept.
        //
        // For every other tool the dedup matches on the ORIGINATING
        // tool (`input.target.tool` — stamped on every policy-gate
        // elicitation), NOT a shared top-level `kind` bucket. Keying on
        // the cosmetic `kind` enum let a `run_workflow` confirm dedup
        // against an unrelated `web_search` confirm (both bucket to
        // `external_write`) — the cross-intent false positive.
        let recentlyConfirmedByLLM = false;
        if (intentKindForCurrentTool) {
          try {
            if (inner.name === "save_workflow_draft") {
              const approval = await findPriorSaveWorkflowApproval(
                db,
                ctx.tenant_id,
                ctx.conversation_id,
              );
              if (approval && Date.now() - (approval.created_at?.getTime() ?? 0) < 5 * 60 * 1000) {
                recentlyConfirmedByLLM = true;
              }
            } else {
              const recent = await db
                .select({
                  id: conversationElicitations.id,
                  status: conversationElicitations.status,
                  input: conversationElicitations.input,
                  output: conversationElicitations.output,
                  created_at: conversationElicitations.created_at,
                })
                .from(conversationElicitations)
                .where(
                  and(
                    eq(conversationElicitations.tenant_id, ctx.tenant_id),
                    eq(conversationElicitations.conversation_id, ctx.conversation_id),
                    eq(conversationElicitations.tool_name, "ask_user_confirm"),
                  ),
                )
                .orderBy(desc(conversationElicitations.created_at))
                // 20-row scan is a safe-direction bound: a matching
                // confirm beyond the 20 most-recent rows simply isn't
                // found, so the gate re-pauses (asks again) rather than
                // skips — never the other way round. Mirrors the
                // `5 * 60 * 1000` freshness window below.
                .limit(20);
              const head = recent.find((row) => {
                const input = row.input;
                if (typeof input !== "object" || input === null) return false;
                const target = (input as { target?: unknown }).target;
                if (typeof target !== "object" || target === null) return false;
                return (target as { tool?: unknown }).tool === inner.name;
              });
              if (
                head?.status === "resolved" &&
                typeof head.output === "object" &&
                head.output !== null &&
                (head.output as { confirmed?: unknown }).confirmed === true &&
                Date.now() - (head.created_at?.getTime() ?? 0) < 5 * 60 * 1000
              ) {
                recentlyConfirmedByLLM = true;
              }
            }
          } catch {
            // DB blip: fall back to gating. Better to ask twice than
            // silently elide a security-critical confirm.
          }
        }
        // Prose-pre-confirmation dedupe: when the LLM wrote a prose
        // pre-confirmation ("Shall I proceed to delete all 6
        // workflows?", "Confirm if I should delete the connector?")
        // and the user immediately answered with a clear affirmation
        // ("yes" / "go ahead" / "do it") in the next user message,
        // treat that exchange as the confirmation and skip the
        // policy-gate elicitation. Pre-fix the LLM kept writing prose
        // pre-confirmations across 6+ versions despite skill rules
        // forbidding them, producing the visible "ask twice" anti-
        // pattern (session abeefb33: prose "Shall I proceed?" + user
        // "yes" + structured ConfirmPrompt for the same delete).
        // Heuristic is scoped to the IMMEDIATELY-PRECEDING two
        // messages and a 5-minute freshness window so the path
        // cannot retroactively wave through an unrelated approval.
        //
        // The recent-messages query only runs for tools where prose
        // dedupe can actually apply (`delete_*` / `revoke_*`). For every
        // other tool `referencesProseConfirmation` short-circuits to
        // false, so running the query would be a guaranteed no-op DB
        // round-trip on every tool call (FIX 7 / INCONSISTENCY-2).
        let recentlyConfirmedByProse = false;
        if (proseConfirmationApplies(inner.name)) {
          try {
            const recentMessages = await db
              .select({
                role: conversationMessages.role,
                content: conversationMessages.content,
                created_at: conversationMessages.created_at,
              })
              .from(conversationMessages)
              .where(
                and(
                  eq(conversationMessages.tenant_id, ctx.tenant_id),
                  eq(conversationMessages.conversation_id, ctx.conversation_id),
                ),
              )
              .orderBy(desc(conversationMessages.created_at))
              .limit(4);
            // Walk newest → older, looking for [user-affirm, assistant-question]
            // pairs where the assistant question references the same tool
            // (or destructive verb) the gate is about to fire on.
            const FIVE_MIN_MS = 5 * 60 * 1000;
            for (let i = 0; i < recentMessages.length - 1; i++) {
              const userMsg = recentMessages[i];
              const asstMsg = recentMessages[i + 1];
              if (!userMsg || !asstMsg) continue;
              if (userMsg.role !== "user" || asstMsg.role !== "assistant") continue;
              if (userMsg.created_at && Date.now() - userMsg.created_at.getTime() > FIVE_MIN_MS)
                break;
              const userText = extractText(userMsg.content);
              const asstText = extractText(asstMsg.content);
              if (!isAffirmation(userText)) continue;
              if (!referencesProseConfirmation(asstText, inner.name)) continue;
              recentlyConfirmedByProse = true;
              break;
            }
          } catch {
            // DB blip: fall back to gating. Better to ask twice than
            // silently elide a security-critical confirm.
          }
        }
        // Gate decision is driven by `resolvedMode` ALONE — not by
        // `inner.category`. The legacy `category === "tenant_write"`
        // filter conflated "needs confirmation" with "stages a
        // confirmation-state-machine row" and silently let `draft_write`
        // tools that demand confirm_before_execution (notably
        // `save_workflow_draft`) bypass the gate, where they then died with
        // `no_prior_approval` because no elicitation was ever created.
        // The state-machine recording at `recordTransition` below stays
        // scoped to `tenant_write` — that part of the original guard
        // is still correct.
        const needsPreConfirmation =
          resolvedMode === "confirm_before_execution" &&
          !policyMarker &&
          !recentlyConfirmedByLLM &&
          !recentlyConfirmedByProse;
        if (recentlyConfirmedByLLM && resolvedMode === "confirm_before_execution") {
          logger.info({
            module: "conversation_tool",
            action: "tool_policy.confirmation_deduped",
            msg: "skipping policy-gate confirm — LLM already elicited and user approved",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            intent_kind: intentKindForCurrentTool,
          });
        }
        if (recentlyConfirmedByProse && resolvedMode === "confirm_before_execution") {
          logger.info({
            module: "conversation_tool",
            action: "tool_policy.prose_confirmation_deduped",
            msg: "skipping policy-gate confirm — prose pre-confirmation matched + user affirmed",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
          });
        }
        // Forensic log when the gate was evaluated but skipped, so the
        // next "tool ran without confirmation" investigation can read
        // why directly from engine logs instead of bisecting the
        // wrapper. Pre-fix this exact failure mode silently swallowed
        // a save_workflow_draft call (session dca36b29 — `paused: false,
        // committed: false, error: no_prior_approval`).
        if (resolvedMode === "confirm_before_execution" && !needsPreConfirmation) {
          const skipReason = policyMarker
            ? "policy_marker_present"
            : recentlyConfirmedByLLM
              ? "recently_confirmed_by_llm"
              : recentlyConfirmedByProse
                ? "recently_confirmed_by_prose"
                : "unknown";
          logger.info({
            module: "conversation_tool",
            action: "policy.gate_skipped",
            msg: "policy gate skipped despite confirm_before_execution mode",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            category: inner.category,
            skip_reason: skipReason,
            ...(intentKindForCurrentTool ? { intent_kind: intentKindForCurrentTool } : {}),
          });
        }

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
              parent_message_id: assistantMessageId,
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
          // Per-tool summary so the confirmation card can show the
          // operator what they're about to approve. For `run_workflow`,
          // include the workflow's display name + the last preview's
          // step count + summary so the operator sees concrete
          // context, not just the policy mode. Mirrors the reference
          // impl's `run_tool` confirm UX which surfaces the test
          // payload + last output.
          const buildPolicyGateSummary = (): string => {
            if (inner.name === "run_workflow") {
              const draft = ctx.getDraft();
              const wfName =
                draft.summary?.active_target?.name ?? draft.workflow?.name ?? "(unnamed)";
              const env =
                (rawArgs &&
                  typeof rawArgs === "object" &&
                  (rawArgs as { environment?: string }).environment) ??
                "dev";
              const lastPreview = draft.latest_preview;
              const previewBit = lastPreview?.summary
                ? ` · last preview: ${lastPreview.summary.slice(0, 80)}`
                : "";
              return `Run workflow "${wfName}" in ${env}${previewBit}`;
            }
            return `Confirm ${inner.name} (policy: ${resolvedMode})`;
          };
          const policyGateSummary = buildPolicyGateSummary();
          // Top-level kind matters: `save_workflow_draft` MUST stamp
          // `kind: "save_workflow_draft"` so the inner prior-approval gate in
          // commit-workflow.ts:54-89 finds the resolved row when the
          // LLM re-issues with __policy_confirmed: true.
          const topLevelKind = topLevelElicitationKindForTool(inner.name);
          // Optional commit_intent so `maybeAutoPersistFromElicitation`
          // (service.ts:551 → auto-persist.ts) can apply the write
          // atomically the moment the operator confirms — bypassing
          // the LLM re-issue round-trip entirely.
          const policyCommitIntent = buildPolicyGateCommitIntent(inner.name, rawArgs);
          const elicitationInput: Record<string, unknown> = {
            kind: topLevelKind,
            question: `Policy requires confirmation before running ${inner.name}. Proceed?`,
            target: { tool: inner.name, args: rawArgs },
            ...confirmationMetadataForTool(inner.name, rawArgs),
            ...(pendingOutput ? { pending_output: pendingOutput } : {}),
            ...(policyCommitIntent ? { commit_intent: policyCommitIntent } : {}),
          };
          const elicitation = await createElicitation(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              tool_call_id: toolCallId,
              parent_message_id: assistantMessageId,
              tool_name: "ask_user_confirm",
              summary: policyGateSummary,
              input: elicitationInput,
              actor_id: ctx.actor_id,
            },
            db,
          );
          signals.pendingChildElicitationIds.push(elicitation.id);
          // Forensic log: confirmation event was emitted with full
          // payload context so an operator triaging "did the gate
          // actually pause?" can answer it from logs alone.
          logger.info({
            module: "conversation_tool",
            action: "policy.gate_paused",
            msg: "policy gate paused tool execution and emitted ask_user_confirm",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            category: inner.category,
            elicitation_id: elicitation.id,
            tool_call_id: toolCallId,
            elicitation_kind: topLevelKind,
            has_commit_intent: policyCommitIntent !== null,
            ...(policyCommitIntent
              ? { commit_intent_kind: policyCommitIntent.kind as string }
              : {}),
          });
          // Stamp `status: "awaiting_confirmation"` so any CLI card that
          // dispatches on `tool: "run_workflow" | "save_workflow_draft"` and
          // reads `data.status` shows a meaningful pending state instead
          // of falling into the "Execution status missing" branch.
          // Pre-fix this output was status-less and the ExecutionDiagnosisCard
          // briefly rendered `× bug, not a state` for the operator.
          const output = {
            pending: true,
            status: "awaiting_confirmation" as const,
            policy_mode: resolvedMode,
            elicitation_id: elicitation.id,
            note: policyCommitIntent
              ? "policy_confirm_required — the operator must confirm via the emitted ask_user_confirm. The harness will auto-persist on confirm via the attached commit_intent; you do NOT need to re-issue this tool call."
              : "policy_confirm_required — operator must confirm before the tool executes. Re-issue the same call with __policy_confirmed: true after receiving confirmation.",
          };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output,
            parent_message_id: assistantMessageId,
          });
          events.push({
            type: "elicit_request",
            elicitation_id: elicitation.id,
            tool_call_id: toolCallId,
            tool_name: "ask_user_confirm",
            summary: elicitation.summary,
            input: elicitation.input,
            parent_message_id: assistantMessageId,
            ...(pendingOutput ? { pending_output: pendingOutput } : {}),
          });
          signals.pendingElicitation = {
            elicitation_id: elicitation.id,
            tool_name: "ask_user_confirm",
            kind: topLevelKind,
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
              kind: topLevelKind,
              input: elicitationInput,
            },
          };
        }

        // Resolve `{ "$file": "fid_..." }` refs inside rawArgs before
        // handing them to the tool. The canonical resolver lives at
        // `files/resolver.ts` — `walkAndResolve` replaces every ref
        // leaf with a `ResolvedFile` whose `openRead()` returns the
        // bytes stream. Unknown / cross-tenant fids throw
        // `FileNotFoundError`; we surface that as a typed error
        // exactly like the legacy attachment-slug failure mode.
        const resolveCache = new Map<string, ResolvedFile>();
        let resolvedArgs: Record<string, unknown>;
        try {
          resolvedArgs = await walkAndResolve(
            rawArgs,
            { db, tenant_id: ctx.tenant_id },
            resolveCache,
          );
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            const output: Record<string, unknown> = {
              ok: false,
              persistence: "none",
              error: {
                code: "file_not_found",
                message: err.message,
              },
            };
            await updateToolCallOutput(db, toolCallId, output);
            events.push({
              type: "tool_result",
              call_id: toolCallId,
              tool: inner.name,
              output,
              parent_message_id: assistantMessageId,
            });
            release();
            return { ok: false, data: output };
          }
          throw err;
        }

        // Tool-driven skill autoload. Before dispatch, ask the
        // data-driven matcher (skill-autoload.ts) which active skills'
        // `activates_when` rules match the about-to-run tool and the
        // conversation's connector scope, then append any missing
        // slugs to `loaded_skills` so the next context assembly sees
        // their bodies. Idempotent — already-loaded slugs are filtered.
        try {
          const convRow = await db
            .select({ loaded_skills: conversations.loaded_skills })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenant_id, ctx.tenant_id),
                eq(conversations.id, ctx.conversation_id),
              ),
            )
            .limit(1);
          const currentlyLoaded = (convRow[0]?.loaded_skills ?? []) as string[];
          const [catalog, scope] = await Promise.all([
            loadActivationCatalog(ctx.tenant_id, db),
            resolveScopeFactsForConversation(db, ctx.tenant_id, ctx.conversation_id, rawArgs),
          ]);
          const additions = autoloadForToolCall(
            { tool: inner.name, input: rawArgs, ...scope },
            catalog,
            currentlyLoaded,
          );
          if (additions.length > 0) {
            await db
              .update(conversations)
              .set({ loaded_skills: [...currentlyLoaded, ...additions] })
              .where(eq(conversations.id, ctx.conversation_id));
            logger.debug({
              module: "conversations.skill_autoload",
              action: "skill_autoload.applied",
              conversation_id: ctx.conversation_id,
              tool: inner.name,
              added_skills: additions,
            });
          }
        } catch (err) {
          // Autoload is best-effort: a DB blip must never block tool
          // execution. The next turn will retry from the persisted
          // state.
          logger.warn({
            module: "conversations.skill_autoload",
            action: "skill_autoload.failed",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Langfuse trace span around the tool execution. Inert no-op
        // when LANGFUSE_PUBLIC_KEY/SECRET_KEY are unset; redacts any
        // ${cred.*} placeholders + sensitive-looking values in input
        // and output before they leave the process.
        const langfuseSpan = await startToolSpan({
          name: inner.name,
          input: resolvedArgs,
          metadata: {
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            category: inner.category,
            session_id: ctx.conversation_id,
          },
        });

        let result: ToolResult;
        try {
          result = await inner.execute(perCallCtx, resolvedArgs);
        } catch (err) {
          await langfuseSpan.finish({ status: "error", error: err });
          const msg = err instanceof Error ? err.message : String(err);
          const output = { error: msg };
          await updateToolCallOutput(db, toolCallId, output);
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output,
            parent_message_id: assistantMessageId,
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
        // Close the Langfuse span with the post-tool payload. `success`
        // mirrors the structured `ok` flag: a tool that returns
        // `{ ok: false }` is a recoverable result, not an error,
        // but it lights up `level: WARNING` so operators can spot
        // a high rate of `ok:false` returns in the dashboard.
        await langfuseSpan.finish({
          output: resultPayload,
          status: result.ok ? "success" : "error",
        });
        await updateToolCallOutput(db, toolCallId, resultPayload);

        // Draft snapshot after every successful draft_write tool. Gives
        // the operator a rollback target if the next edit goes wrong;
        // LRU-capped at 10 per conversation so the table can't grow
        // unbounded. Best-effort — a failure here logs but does not
        // block the tool result from reaching the LLM.
        if (result.ok && inner.category === "draft_write") {
          try {
            const draftAfter = ctx.getDraft();
            await createDraftSnapshot(
              {
                tenant_id: ctx.tenant_id,
                conversation_id: ctx.conversation_id,
                turn_index: step,
                draft: draftAfter,
                label: inner.name,
              },
              db,
            );
          } catch (err) {
            logger.warn({
              module: "conversations.draft_snapshot",
              action: "draft_snapshot.failed",
              conversation_id: ctx.conversation_id,
              tool: inner.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // get_raw_result exists to drain a stored `raw_ref` back into the
        // model's context — its whole purpose is to bypass the truncator.
        // If we re-run its output through truncateForLlm, the truncator
        // mints a NEW raw_ref and tells the model "full payload available
        // via get_raw_result(ref=...)" — and the model follows the
        // breadcrumb forever (session 0498925e: 10 consecutive calls,
        // each output growing by 8 chars = the length of the fresh ref).
        // Skip the truncator for this single tool; if the payload exceeds
        // context, the model already accepted that cost by asking for it.
        const skipTruncate = inner.name === "get_raw_result";
        const truncated = skipTruncate
          ? ({ truncated: false, data: resultPayload } as const)
          : truncateForLlm(resultPayload);
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
          parent_message_id: assistantMessageId,
        });
        // Activity ticker: tool ended → switch to idle so the CLI
        // ticker stops showing the tool name. `last_completed` lets
        // the operator see what just finished (codex pattern: prefer
        // visibility over silence) even after the call card scrolls.
        const completedDurationMs = Date.now() - startedAt;
        events.push({
          type: "activity",
          phase: "idle",
          label: `last: ${inner.name} ${result.ok ? "ok" : "fail"} · ${completedDurationMs}ms`,
          last_completed: {
            tool_name: inner.name,
            ok: result.ok,
            duration_ms: completedDurationMs,
          },
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
          signals.toolValidationFingerprint.delete(inner.name);
          // First success resets the global consecutive-failures counter.
          signals.consecutiveFailures = 0;
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
          // Validation-fingerprint tracker: catches the case where
          // args differ but the engine keeps returning the same
          // validation error shape. Args-hash repeat detection won't
          // fire there because each call has unique args; this
          // detector watches the OUTPUT shape instead.
          if (Array.isArray(errObj.errors)) {
            const fingerprint = computeValidationFingerprint(
              errObj.errors as Array<{ path?: unknown; message?: unknown }>,
            );
            if (fingerprint) {
              const prior = signals.toolValidationFingerprint.get(inner.name);
              const nextCount = prior?.hash === fingerprint ? prior.count + 1 : 1;
              signals.toolValidationFingerprint.set(inner.name, {
                hash: fingerprint,
                count: nextCount,
              });
              if (nextCount >= MAX_VALIDATION_FINGERPRINT_REPEAT) {
                logger.warn({
                  module: "conversation_tool",
                  action: "tool.validation_fingerprint_cap",
                  msg: "same validation error shape repeated — model must ask user or change approach",
                  conversation_id: ctx.conversation_id,
                  tool: inner.name,
                  fingerprint,
                  repeat_count: nextCount,
                });
                recordToolCircuitOpen({
                  tool: inner.name,
                  reason: "validation_fingerprint_repeat",
                });
                events.push({
                  type: "tool_log",
                  call_id: "validation-fingerprint-cap",
                  tool: inner.name,
                  level: "warn",
                  message: `tool.validation_fingerprint_cap: ${inner.name} hit the SAME validation error shape ${nextCount}× — different args, same constraint. Stop iterating; emit ask_user_choice / ask_user_text describing the constraint and offering a path forward (e.g. simpler workflow, different connector field, hand-edited JSON).`,
                  ts: new Date().toISOString(),
                });
              }
            }
          }
          // Global cap: every ok=false tool result anywhere increments
          // the running counter. The next dispatch tick reads this
          // and short-circuits if the model has not asked the user yet.
          signals.consecutiveFailures += 1;
          if (signals.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.warn({
              module: "conversation_tool",
              action: "tool.consecutive_failures_cap",
              msg: "five consecutive failed tool calls — model must ask the user before continuing",
              conversation_id: ctx.conversation_id,
              tool: inner.name,
              consecutive_failures: signals.consecutiveFailures,
            });
            const capAlternatives = buildCapAlternatives(signals.toolLastErrorHash);
            events.push({
              type: "tool_log",
              call_id: "consecutive-failures",
              tool: inner.name,
              level: "warn",
              message: `tool.consecutive_failures_cap: ${signals.consecutiveFailures} failed tool calls in a row — emit ask_user_choice / ask_user_text instead of patching further.${capAlternatives}`,
              ts: new Date().toISOString(),
            });
          }
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
          const enrichedInputPayload =
            inputPayload && typeof inputPayload === "object"
              ? {
                  ...confirmationMetadataForTool(inner.name, rawArgs),
                  ...(inputPayload as Record<string, unknown>),
                }
              : inputPayload;
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
            tool_call_id: toolCallId,
            tool_name: result.pause.tool_name,
            summary: result.pause.summary,
            input: enrichedInputPayload,
            parent_message_id: assistantMessageId,
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
            input: enrichedInputPayload,
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

        // Post-execution review pause (mirrors reference impl's
        // `confirm_after_execution`). When the resolved mode says the
        // tool's RESULT must be reviewed before the loop continues,
        // and the tool body succeeded (ok=true) and didn't already
        // emit its own pause, synthesise an `ask_user_confirm`
        // elicitation carrying the captured result. The operator
        // accepts → loop resumes; declines → loop receives a
        // `result_review_declined` envelope (subkit's tenant_write
        // tools are mostly idempotent / non-rollbackable, so we don't
        // attempt automatic rollback — declining is logged + surfaced
        // and the model decides on the next turn).
        if (
          resolvedMode === "confirm_after_execution" &&
          result.ok &&
          !result.pause &&
          !signals.pendingElicitation &&
          // Inline-credential safeguards already pre-confirmed; don't
          // double-prompt.
          !policyMarker
        ) {
          const reviewElicitation = await createElicitation(
            {
              tenant_id: ctx.tenant_id,
              conversation_id: ctx.conversation_id,
              tool_call_id: toolCallId,
              parent_message_id: assistantMessageId,
              tool_name: "ask_user_confirm",
              summary: `Review result of ${inner.name}`,
              input: {
                kind: REVIEW_AFTER_EXECUTION_KIND,
                summary: `Review result of ${inner.name}`,
                target: { tool: inner.name, args: rawArgs },
                ...confirmationMetadataForTool(inner.name, rawArgs),
                pending_output: resultPayload,
              },
              actor_id: ctx.actor_id,
            },
            db,
          );
          const reviewElicitationId = reviewElicitation.id;
          signals.pendingChildElicitationIds.push(reviewElicitationId);
          events.push({
            type: "elicit_request",
            elicitation_id: reviewElicitationId,
            tool_call_id: toolCallId,
            tool_name: "ask_user_confirm",
            summary: `Review result of ${inner.name}`,
            input: {
              kind: REVIEW_AFTER_EXECUTION_KIND,
              question: `${inner.name} ran. Keep this result?`,
              target: { tool: inner.name, args: rawArgs },
              ...confirmationMetadataForTool(inner.name, rawArgs),
            },
            parent_message_id: assistantMessageId,
            pending_output: resultPayload as Record<string, unknown>,
          });
          log.conversation.approval.requested({
            conversation_id: ctx.conversation_id,
            approval_id: reviewElicitationId,
            kind: REVIEW_AFTER_EXECUTION_KIND,
          });
          signals.pendingElicitation = {
            elicitation_id: reviewElicitationId,
            tool_name: "ask_user_confirm",
            kind: REVIEW_AFTER_EXECUTION_KIND,
            summary: `Review result of ${inner.name}`,
            input: {
              kind: REVIEW_AFTER_EXECUTION_KIND,
              question: `${inner.name} ran. Keep this result?`,
              target: { tool: inner.name, args: rawArgs },
              ...confirmationMetadataForTool(inner.name, rawArgs),
            },
          };
          logger.info({
            module: "conversation_tool",
            action: "post_execution_pause.created",
            msg: "tool ran; pausing for operator review (confirm_after_execution)",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            elicitation_id: reviewElicitationId,
          });
          return {
            ok: result.ok,
            data: resultPayload,
            pause: {
              tool_name: "ask_user_confirm",
              kind: "generic",
              summary: `Review result of ${inner.name}`,
              elicitation_id: reviewElicitationId,
              input: {
                kind: REVIEW_AFTER_EXECUTION_KIND,
                question: `${inner.name} ran. Keep this result?`,
                target: { tool: inner.name, args: rawArgs },
              },
            },
            ...(result.committed_workflow_id
              ? { committed_workflow_id: result.committed_workflow_id }
              : {}),
          };
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
