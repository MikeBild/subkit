import type { z } from "@hono/zod-openapi";
import { type Tool, tool } from "ai";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { withContext } from "../../../logging/context.ts";
import { errorFields, log, logger } from "../../../logging/logger.ts";
import { stampMcpTaskProgress } from "../../../mcp/tasks/store.ts";
import {
  recordConversationToolCall,
  recordConversationToolError,
  recordToolCircuitOpen,
} from "../../../observability/instrumentation.ts";
import { startToolSpan } from "../../../observability/langfuse-spans.ts";
import { readMemoryUsage } from "../../../observability/runtime-telemetry.ts";
import { skillAudienceForAuthoringMode } from "../../../skills/types.ts";
import { stripConfirmMarkers } from "../../../tools/approval.ts";
import { listWorkflowsUsingConnector } from "../../../workflows/connector-refs.ts";
import {
  FileNotFoundError,
  pinAttachmentFileId,
  type ResolvedFile,
  resolveAttachmentSlugsInArgs,
  walkAndResolve,
} from "../../attachments.ts";
import { recordTransition, runConfirmGate } from "../../confirmation.ts";
import { createDraftSnapshot } from "../../draft-checkpoints.ts";
import { createElicitation } from "../../elicitations.ts";
import { executionSuppressionRefusal } from "../../execution-suppression.ts";
import { saveEvidenceLabel } from "../../handoff-summary.ts";
import { detectUserIntent } from "../../intent-detector.ts";
import { parseLoadedSkills } from "../../loop/skill-recency.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import { resolveSaveVerification } from "../../persistence/commit-workflow.ts";
import { findPriorSaveWorkflowApproval } from "../../persistence/save-workflow-approval.ts";
import { resolveScopeFactsForConversation } from "../../scope-facts.ts";
import {
  autoloadForDiagnoses,
  autoloadForToolCall,
  diagnosisCodesFromToolResult,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../../skill-autoload.ts";
import { computeLineDiff } from "../../text-line-diff.ts";
import { describeToolExecutionFailure } from "../../tool-execution-failure.ts";
import type { PermissionMode, ToolPolicies } from "../../tool-policies.ts";
import { assertConversationTurn } from "../../turns.ts";
import type { TurnEvent } from "../../types.ts";
import { withApprovalHandle, withoutApprovalHandle } from "../ask-user/commit-intent.ts";
import { decodeAskUserPromptEscapes } from "../ask-user/decode-prompt-escapes.ts";
import { isLiveExecutionTool, isWorkflowExecutionTool } from "../authoring-palette.ts";
import { hideCapabilityLinks } from "../capability-link.ts";
import { compileDescription } from "../describe.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../index.ts";
import {
  checkToolPermission,
  resolveConversationPrincipal,
  type ToolPermissionResult,
} from "../permission-gate.ts";
import {
  GENERIC_TOOL_FAILURE_CODE,
  normalizeToolResultPayload,
  toolCallOutcome,
} from "../result-payload.ts";
import {
  boundForPersistence,
  type TruncatedOutput,
  truncateForLlm,
  withTruncationMarkers,
} from "../truncate.ts";
import { buildCapAlternatives, metricErrorCode } from "./error-recovery-hints.ts";
import { type GateSubject, prepareGate } from "./gate-subjects.ts";
import {
  INTAKE_REVIEW_BLOCKED_WRITES,
  INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE,
  intakeReviewBlocksWrite,
} from "./intake-review-guard.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import {
  buildConfirmedToolCallIntent,
  buildPolicyGateCommitIntent,
  confirmationMetadataForTool,
  mapToolToCommitIntentKind,
  REVIEW_AFTER_EXECUTION_KIND,
  summarizeToolData,
  summarizeToolFailure,
  topLevelElicitationKindForTool,
} from "./policy-helpers.ts";
import { checkBeforeGate, describeToolEffect, permissionRefusal } from "./pregate.ts";
import { redactToolArgsForPersist } from "./redact-tool-args.ts";
import {
  computeValidationFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ERROR_CODE_REPEAT,
  MAX_TURN_LOOP_WARNINGS,
  MAX_VALIDATION_FINGERPRINT_REPEAT,
  type TurnSignals,
  type WrappedToolOutput,
} from "./state.ts";

const PRIOR_APPROVAL_WINDOW_MS = 5 * 60 * 1000;

export { INTAKE_REVIEW_BLOCKED_WRITES, intakeReviewBlocksWrite };

let heapSnapshotWritten = false;

export function toInputExamples(
  example: Readonly<Record<string, unknown>> | undefined,
): { inputExamples: Array<{ input: Record<string, unknown> }> } | Record<string, never> {
  if (!example || Object.keys(example).length === 0) return {};
  return { inputExamples: [{ input: { ...example } }] };
}

function committedWorkflowIdFromResult(result: ToolResult): string | null {
  const workflowId = result.committed_workflow_id;
  if (typeof workflowId !== "string") return null;
  const data = "data" in result ? result.data : undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.already_persisted === true || record.version_changed === false) return null;
  }
  return workflowId;
}

async function autoloadForResultDiagnoses(
  db: Db,
  ctx: ToolContext,
  tool: string,
  resultPayload: unknown,
): Promise<void> {
  const codes = diagnosisCodesFromToolResult(resultPayload);
  if (codes.length === 0) return;
  try {
    const [row] = await db
      .select({ loaded_skills: conversations.loaded_skills, turn_count: conversations.turn_count })
      .from(conversations)
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      )
      .limit(1);
    const entries = parseLoadedSkills(row?.loaded_skills, () => {});
    const additions = autoloadForDiagnoses(
      codes,
      await loadActivationCatalog(ctx.tenant_id, db),
      entries.map((e) => e.slug),
      ctx.surface,
      skillAudienceForAuthoringMode(ctx.getDraft().summary?.mode),
    );
    if (additions.length === 0) return;
    const turn = row?.turn_count ?? 0;
    await db
      .update(conversations)
      .set({
        loaded_skills: [...entries, ...additions.map((slug) => ({ slug, last_turn: turn }))],
      })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    logger.debug({
      module: "conversations.skill_autoload",
      action: "skill_autoload.diagnosis_applied",
      conversation_id: ctx.conversation_id,
      tool,
      diagnosis_codes: codes,
      added_skills: additions,
    });
  } catch (err) {
    logger.warn({
      module: "conversations.skill_autoload",
      action: "skill_autoload.failed",
      conversation_id: ctx.conversation_id,
      tool,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  const inputSchema = inner.inputSchema as unknown as z.ZodType<Record<string, unknown>>;
  return tool<Record<string, unknown>, WrappedToolOutput, Record<string, unknown>>({
    description: compileDescription(inner),
    inputSchema,
    toModelOutput: jsonSafeModelOutput,
    ...(inner.strict !== undefined ? { strict: inner.strict } : {}),
    ...toInputExamples(inner.example_input),
    async execute(modelArgs: Record<string, unknown>): Promise<WrappedToolOutput> {
      const decodedArgs = decodeAskUserPromptEscapes(inner.name, modelArgs);
      const rawArgs = inner.accepts_attachment_file_id
        ? await pinAttachmentFileId(decodedArgs, {
            db,
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
          })
        : decodedArgs;
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      const executeBody = async (): Promise<WrappedToolOutput> => {
        await assertConversationTurn(ctx.abortSignal);
        const requestedExternalRead =
          inner.name === "run_workflow" &&
          detectUserIntent(ctx.recentUserMessage).requestExternalRead === true;
        const suppressionRefusal =
          isWorkflowExecutionTool(inner.name) && !requestedExternalRead
            ? await executionSuppressionRefusal({
                db: ctx.db,
                tenant_id: ctx.tenant_id,
                conversation_id: ctx.conversation_id,
                recent_user_message: ctx.recentUserMessage ?? null,
                live_tool: isLiveExecutionTool(inner.name),
              })
            : null;
        if (suppressionRefusal) return { ok: false, data: suppressionRefusal };
        if (intakeReviewBlocksWrite(ctx.getDraft(), inner.name)) {
          return {
            ok: false,
            data: {
              error: "intake_review_requires_human_confirmation",
              error_code: "intake_review_requires_human_confirmation",
              next_best_actions: [],
              message: `This conversation is reviewing collected material. Create or revise an intake proposal; a person confirms the exact content, sources, and destination in the review before it becomes knowledge or a skill. ${INTAKE_REVIEW_KNOWLEDGE_EDIT_NOTE}`,
            },
          };
        }
        const isAskUser = inner.name.startsWith("ask_user_");
        const isInspect =
          inner.name.startsWith("inspect_") || inner.name === "diagnose_latest_execution";
        if (!isAskUser && !isInspect && signals.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          signals.totalLoopWarnings += 1;
          const turnBudgetReached = signals.totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
          recordToolCircuitOpen({
            tool: inner.name,
            reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "consecutive_failures_cap",
          });
          logger.warn({
            module: "conversation_tool",
            action: "tool.consecutive_failures_block",
            msg: turnBudgetReached
              ? "global consecutive-failures cap + turn loop budget exhausted — ending turn"
              : "global consecutive-failures cap reached — short-circuiting until model asks the user",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            consecutive_failures: signals.consecutiveFailures,
            total_loop_warnings: signals.totalLoopWarnings,
            turn_budget_reached: turnBudgetReached,
          });
          events.push({
            type: "tool_log",
            call_id: "consecutive-failures-cap",
            tool: inner.name,
            level: "warn",
            message: turnBudgetReached
              ? `tool.consecutive_failures_block: ${signals.consecutiveFailures} failed tool calls in a row; turn-level loop budget exhausted (${signals.totalLoopWarnings}) — ending turn`
              : `tool.consecutive_failures_block: ${signals.consecutiveFailures} failed tool calls in a row — emit ask_user_choice / ask_user_text instead of retrying.`,
            ts: new Date().toISOString(),
          });
          if (turnBudgetReached) {
            return {
              ok: false,
              data: {
                error_code: "turn_loop_budget_exhausted",
                message: `this turn failed ${signals.consecutiveFailures} tool calls in a row and exceeded the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`,
                reason: "turn_loop_budget_exhausted",
                consecutive_failures: signals.consecutiveFailures,
                next_best_actions: ["ask_user_choice", "ask_user_text"],
              },
            };
          }
          const alternatives = buildCapAlternatives(signals.toolLastErrorHash);
          const recommendedOptions = [
            {
              value: "restart_simple",
              label: "Abandon the current draft and start over with a simpler design",
            },
            {
              value: "inspect_failures",
              label: "Show me the recent error traces before I decide",
            },
            { value: "abort", label: "Stop here — I'll come back to this later" },
          ];
          return {
            ok: false,
            data: {
              error_code: "consecutive_failures_cap",
              message: `${signals.consecutiveFailures} tool calls have failed in a row — stop patching and emit ask_user_choice with the recommended_options below (or derive your own from the most recent failure). The cap resets on the first successful tool call.${alternatives}`,
              reason: "consecutive_failures_cap",
              consecutive_failures: signals.consecutiveFailures,
              recommended_options: recommendedOptions,
              next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
            },
          };
        }

        const errorCodeStreak = signals.toolErrorCodeRepeat.get(inner.name);
        if (
          !isAskUser &&
          !isInspect &&
          errorCodeStreak &&
          errorCodeStreak.count >= MAX_ERROR_CODE_REPEAT
        ) {
          signals.totalLoopWarnings += 1;
          const turnBudgetReached = signals.totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
          recordToolCircuitOpen({
            tool: inner.name,
            reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "error_code_repeat",
          });
          logger.warn({
            module: "conversation_tool",
            action: "tool.error_code_repeat_block",
            msg: "same error_code repeated for one tool — short-circuiting until the model asks the user",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            error_code: errorCodeStreak.code,
            repeat_count: errorCodeStreak.count,
            total_loop_warnings: signals.totalLoopWarnings,
            turn_budget_reached: turnBudgetReached,
          });
          events.push({
            type: "tool_log",
            call_id: "error-code-repeat",
            tool: inner.name,
            level: "warn",
            message: `tool.error_code_repeat_block: ${inner.name} returned \`${errorCodeStreak.code}\` ${errorCodeStreak.count}× this turn — different args, same refusal. Stop retrying; emit ask_user_choice / ask_user_text describing the blocker and offering a path forward.`,
            ts: new Date().toISOString(),
          });
          return {
            ok: false,
            data: {
              error_code: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_error_repeat",
              message: turnBudgetReached
                ? `this turn keeps hitting the same blocker (${errorCodeStreak.code}) — stop, summarise what you know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`
                : `${inner.name} has failed with \`${errorCodeStreak.code}\` ${errorCodeStreak.count}× in this turn — the args changed but the blocker did not. Stop retrying and ask the user via ask_user_choice / ask_user_text, or change approach entirely.`,
              reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_error_repeat",
              tool: inner.name,
              repeated_error_code: errorCodeStreak.code,
              repeat_count: errorCodeStreak.count,
              next_best_actions: ["ask_user_choice", "ask_user_text", "inspect_workflow"],
            },
          };
        }

        const REPEAT_THRESHOLD = 3;
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
        const priorSuccess =
          signals.lastExecutionSuccess &&
          signals.lastExecutionSuccess.tool === inner.name &&
          signals.lastExecutionSuccess.args_hash === argsHash
            ? signals.lastExecutionSuccess.output
            : undefined;
        const repeatsSuccessfulExecution = priorSuccess !== undefined && repeatCount >= 2;
        const tripped =
          !isReadOnly && (repeatCount >= REPEAT_THRESHOLD || repeatsSuccessfulExecution);
        if (tripped) {
          signals.totalLoopWarnings += 1;
          const turnBudgetReached = signals.totalLoopWarnings >= MAX_TURN_LOOP_WARNINGS;
          log.conversation.tool.called({
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            step: signals.step,
          });
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
            repeats_successful_execution: repeatsSuccessfulExecution,
            turn_budget_reached: turnBudgetReached,
          });
          events.push({
            type: "tool_log",
            call_id: "loop-detected",
            tool: inner.name,
            level: "warn",
            message: turnBudgetReached
              ? `tool.loop_detected: ${inner.name} repeated identical args ${repeatCount}×; turn-level loop budget exhausted (${signals.totalLoopWarnings}) — ending turn`
              : repeatsSuccessfulExecution
                ? `tool.loop_detected: ${inner.name} already succeeded with identical args this turn — present the prior_success_output instead of running it again`
                : `tool.loop_detected: ${inner.name} called with identical args ${repeatCount}× in a row — change approach or ask the user`,
            ts: new Date().toISOString(),
          });
          return {
            ok: false,
            data: {
              error_code: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
              message: priorSuccess
                ? `${inner.name} already succeeded with these exact args this turn — its result is attached as prior_success_output. Present THAT result to the user; do NOT run it again.`
                : turnBudgetReached
                  ? `this turn called tools ${signals.totalLoopWarnings}× past the loop-warning budget — stop, summarise what you already know, and end the turn with a single question for the user (use ask_user_choice or ask_user_text, not prose).`
                  : `${inner.name} has been called with identical args ${repeatCount}× in a row in this turn — change the args or stop and ask the user via ask_user_choice / ask_user_text. Do NOT retry with the SAME shape.`,
              reason: turnBudgetReached ? "turn_loop_budget_exhausted" : "tool_loop_detected",
              tool: inner.name,
              repeat_count: repeatCount,
              ...(priorSuccess !== undefined ? { prior_success_output: priorSuccess } : {}),
              next_best_actions: ["ask_user_choice", "ask_user_text", "diagnose_latest_execution"],
            },
          };
        }
        signals.toolInvocationCount.set(inner.name, priorCount + 1);

        if (signals.step === 0) {
          const m = readMemoryUsage();
          const external_mb = Math.round(m.external / (1024 * 1024));
          let heapDiag: Record<string, unknown> = {};
          if (process.env.SUBKIT_HEAP_DIAG === "1") {
            try {
              const { heapStats } = await import("bun:jsc");
              const h = heapStats();
              heapDiag = {
                heap_size_mb: Math.round(h.heapSize / (1024 * 1024)),
                extra_memory_mb: Math.round((h.extraMemorySize ?? 0) / (1024 * 1024)),
                heap_top: Object.entries(h.objectTypeCounts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8),
              };
              if (external_mb > 512 && !heapSnapshotWritten) {
                heapSnapshotWritten = true;
                const snapshotPath = `/tmp/subkit-heap-first-tool-${Date.now()}.json`;
                await Bun.write(snapshotPath, JSON.stringify(Bun.generateHeapSnapshot()));
                heapDiag.heap_snapshot_path = snapshotPath;
              }
            } catch (err) {
              heapDiag = { heap_diag_error: err instanceof Error ? err.message : String(err) };
            }
          }
          logger.info({
            module: "process",
            action: "step.memory",
            at: "first_tool_start",
            tool: inner.name,
            external_mb,
            rss_mb: Math.round(m.rss / (1024 * 1024)),
            ...heapDiag,
          });
        }
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
          input: redactToolArgsForPersist(inner.name, rawArgs),
          approval_required: inner.name.startsWith("ask_user_"),
        });
        await stampMcpTaskProgress(ctx.tenant_id, ctx.conversation_id, inner.name, rawArgs, db);
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
          emitDiff: ({ title, language, before, after }) => {
            try {
              const hunks = computeLineDiff(before, after, { context: 3 });
              if (hunks.length === 0) return;
              events.push({ type: "diff", title, language, hunks });
            } catch {}
          },
        };

        const policyEnvironment =
          typeof (rawArgs as { environment?: unknown }).environment === "string"
            ? (rawArgs as { environment: string }).environment
            : undefined;
        const intentKindForCurrentTool = mapToolToCommitIntentKind(inner.name);
        let priorApproval = false;
        if (inner.name === "save_workflow_draft") {
          try {
            const approval = await findPriorSaveWorkflowApproval(
              db,
              ctx.tenant_id,
              ctx.conversation_id,
            );
            if (
              approval &&
              Date.now() - (approval.created_at?.getTime() ?? 0) < PRIOR_APPROVAL_WINDOW_MS
            ) {
              priorApproval = true;
            }
          } catch {}
        }
        const principal = ctx.principal ?? (await resolveConversationPrincipal(perCallCtx));
        const pendingElicitationBeforeGate = signals.pendingElicitation;
        const preparedGate = await prepareGate(
          inner.name,
          stripConfirmMarkers(rawArgs),
          ctx.tenant_id,
          db,
          ctx.locale,
        );
        const gate = await runConfirmGate({
          tool: inner.name,
          category: inner.category,
          surface: "chat",
          args: preparedGate.args,
          overrides: toolPolicies,
          permission_mode: permissionMode,
          prior_approval: priorApproval,
          ...(preparedGate.execution_data_transfer ? { execution_data_transfer: true } : {}),
          db,
          tenant_id: ctx.tenant_id,
          principal,
          approval_tool: inner.name,
          via: "chat",
          record_surface: ctx.surface ?? "api",
          conversation_id: ctx.conversation_id,
          actor_id: ctx.actor_id ?? null,
          execution_mode:
            policyEnvironment === "prod" || policyEnvironment === "dev" ? policyEnvironment : null,
          precheck: () => checkBeforeGate(inner, perCallCtx, rawArgs),
          pause_blocked: pendingElicitationBeforeGate !== undefined,
          confirmation_kind: topLevelElicitationKindForTool(inner.name),
          ...(policyEnvironment !== undefined ? { environment: policyEnvironment } : {}),
        });
        const resolvedMode = gate.record.mode;
        if (gate.kind === "proceed" && resolvedMode === "confirm_before_execution") {
          logger.info({
            module: "conversation_tool",
            action: "policy.gate_skipped",
            msg: "policy gate skipped despite confirm_before_execution mode",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            category: inner.category,
            skip_reason: gate.decision.skip_reason,
            ...(intentKindForCurrentTool ? { intent_kind: intentKindForCurrentTool } : {}),
          });
        }
        const pregateRefusal = gate.kind === "refused" ? gate.result : null;
        const gatedEffect = gate.kind === "needs_confirm" ? gate.effect : null;
        const bypassedConfirmation = gate.record.bypassed_confirmation;

        if (inner.category === "tenant_write" && !pregateRefusal) {
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

        if (gate.kind === "duplicate_pending") {
          const dupOutput = {
            error: "duplicate_pending_elicitation_in_turn",
            error_code: "duplicate_pending_elicitation_in_turn",
            message:
              "Another tool call in this turn already staged an ask_user_confirm. Wait for the user to resolve that one, then re-issue this call after the user confirms.",
            next_best_actions: [],
            existing_elicitation_id: pendingElicitationBeforeGate?.elicitation_id,
            existing_tool: pendingElicitationBeforeGate?.tool_name,
          };
          await updateToolCallOutput(db, toolCallId, dupOutput, "denied");
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

        if (gate.kind === "approval_failed" || gate.kind === "unavailable") {
          const failure = {
            ok: false as const,
            data:
              gate.kind === "approval_failed"
                ? {
                    error_code: "approval_request_failed",
                    message: `${inner.name} requires the operator's confirmation, and the engine could not open one. Nothing ran. Tell the user, and retry only if they ask again.`,
                    reason: "approval_request_failed",
                    next_best_actions: [],
                  }
                : {
                    error_code: "not_available_on_surface",
                    message: gate.reason,
                    reason: "not_available_on_surface",
                    next_best_actions: [],
                  },
          };
          await updateToolCallOutput(db, toolCallId, failure.data, "error");
          events.push({
            type: "tool_result",
            call_id: toolCallId,
            tool: inner.name,
            output: failure.data,
            parent_message_id: assistantMessageId,
          });
          recordConversationToolCall({
            category: inner.category,
            tool: inner.name,
            outcome: "error",
            duration_ms: Date.now() - startedAt,
          });
          return failure;
        }

        if (gate.kind === "needs_confirm") {
          const pendingOutput = preparedGate.pending_output;
          const saveVerification =
            inner.name === "save_workflow_draft"
              ? await resolveSaveVerification(perCallCtx, ctx.getDraft())
              : null;
          const buildPolicyGateSummary = (): string => {
            if (saveVerification) {
              const draft = ctx.getDraft();
              const wfName =
                draft.summary?.active_target?.name ?? draft.workflow?.name ?? "(unnamed)";
              return `Save inactive draft "${wfName}" · test run without effect: ${saveEvidenceLabel(saveVerification)}`;
            }
            if (inner.name === "run_workflow") {
              const draft = ctx.getDraft();
              const explicitWorkflow =
                typeof rawArgs.workflow === "string"
                  ? rawArgs.workflow
                  : typeof rawArgs.workflow_id === "string"
                    ? rawArgs.workflow_id
                    : null;
              const wfName =
                explicitWorkflow ??
                draft.summary?.active_target?.name ??
                draft.workflow?.name ??
                "(unnamed)";
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
            if (inner.name === "apply_package_import") {
              const [subject] = Array.isArray(pendingOutput?.subjects)
                ? (pendingOutput.subjects as GateSubject[])
                : [];
              const label = ctx.locale === "en" ? "Import package" : "Paket importieren";
              return subject?.title ? `${label}: ${subject.title}` : label;
            }
            if (gatedEffect) return describeToolEffect(gatedEffect);
            return `Confirm ${inner.name} (policy: ${resolvedMode})`;
          };
          const policyGateSummary = buildPolicyGateSummary();
          const topLevelKind = topLevelElicitationKindForTool(inner.name);
          let policyCommitIntent = buildPolicyGateCommitIntent(inner.name, rawArgs);
          const policyApprovalUrl = gate.approval_url;
          if (gate.approval_id) {
            policyCommitIntent = policyCommitIntent
              ? withApprovalHandle(policyCommitIntent, gate.approval_id)
              : buildConfirmedToolCallIntent(inner.name, gate.approval_id);
          }
          let connectorDeleteDependents: Array<{ id: string; slug: string; name: string }> = [];
          if (inner.name === "delete_connector") {
            const connectorId = typeof rawArgs.id === "string" ? rawArgs.id : null;
            if (connectorId) {
              connectorDeleteDependents = await listWorkflowsUsingConnector(
                ctx.tenant_id,
                connectorId,
                db,
              );
            }
          }
          const hasConnectorDeleteDependents = connectorDeleteDependents.length > 0;
          const elicitationInput: Record<string, unknown> = {
            kind: topLevelKind,
            question: hasConnectorDeleteDependents
              ? `Deleting this connector will break ${connectorDeleteDependents.length} live workflow${connectorDeleteDependents.length === 1 ? "" : "s"} (${connectorDeleteDependents.map((w) => w.slug).join(", ")}). Proceed anyway?`
              : gatedEffect
                ? `${describeToolEffect(gatedEffect)} — approve this call?`
                : `Policy requires confirmation before running ${inner.name}. Proceed?`,
            target: { tool: inner.name, args: rawArgs },
            ...(gatedEffect ? { effect: gatedEffect } : {}),
            ...(saveVerification ? { verification: saveVerification } : {}),
            ...confirmationMetadataForTool(inner.name, rawArgs),
            ...(pendingOutput ? { pending_output: pendingOutput } : {}),
            ...(policyCommitIntent ? { commit_intent: policyCommitIntent } : {}),
            ...(policyApprovalUrl ? { approval_url: policyApprovalUrl } : {}),
            ...(hasConnectorDeleteDependents
              ? {
                  dependents: connectorDeleteDependents,
                  next_best_actions: ["edit_workflow_patch"],
                }
              : {}),
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
              actor_id: ctx.engineClient.context.actor_id,
              ...(ctx.engineClient.context.actor_type
                ? { actor_type: ctx.engineClient.context.actor_type }
                : {}),
            },
            db,
          );
          signals.pendingChildElicitationIds.push(elicitation.id);
          const operatorInput = withoutApprovalHandle(elicitationInput);
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
          const output = {
            pending: true,
            status: "awaiting_confirmation" as const,
            policy_mode: resolvedMode,
            elicitation_id: elicitation.id,
            ...(policyApprovalUrl ? { approval_url: policyApprovalUrl } : {}),
            note: policyCommitIntent
              ? `policy_confirm_required — nothing ran. The operator must answer the emitted ask_user_confirm; the engine performs ${inner.name} itself once they approve. You do NOT re-issue this call, and you cannot approve on their behalf.${
                  policyApprovalUrl
                    ? ` Present this approval link to the operator verbatim, on its own line, as a bare URL — opening it in a browser IS the authorization (single-use link, no sign-in): ${policyApprovalUrl} Once they decide there, the engine resolves this pause and carries out ${inner.name} on its own, then reports back — so hand over the link and wait rather than asking them to repeat their answer to you.`
                    : ""
                }`
              : `policy_confirm_required — nothing ran, and this turn has no way to release ${inner.name}: no approval handle could be opened for it. Tell the user the action must be performed from an authenticated session.`,
          };
          await updateToolCallOutput(db, toolCallId, output, "pending");
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
            input: operatorInput,
            parent_message_id: assistantMessageId,
            ...(pendingOutput ? { pending_output: pendingOutput } : {}),
          });
          signals.pendingElicitation = {
            elicitation_id: elicitation.id,
            tool_name: "ask_user_confirm",
            kind: topLevelKind,
            summary: policyGateSummary,
            input: operatorInput,
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
              summary: policyGateSummary,
              kind: topLevelKind,
              input: operatorInput,
            },
          };
        }

        const resolveCache = new Map<string, ResolvedFile>();
        let resolvedArgs: Record<string, unknown>;
        try {
          const pinnedArgs = await resolveAttachmentSlugsInArgs(rawArgs, {
            db,
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            principal,
          });
          resolvedArgs = await walkAndResolve(
            pinnedArgs,
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
            await updateToolCallOutput(db, toolCallId, output, "error");
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

        try {
          const convRow = await db
            .select({
              loaded_skills: conversations.loaded_skills,
              turn_count: conversations.turn_count,
            })
            .from(conversations)
            .where(
              and(
                eq(conversations.tenant_id, ctx.tenant_id),
                eq(conversations.id, ctx.conversation_id),
              ),
            )
            .limit(1);
          const currentEntries = parseLoadedSkills(convRow[0]?.loaded_skills, ({ dropped, raw }) =>
            logger.warn({
              module: "conversation",
              action: "skill_recency.malformed_loaded_skills",
              msg: "dropped malformed loaded_skills entries during tool-call autoload",
              conversation_id: ctx.conversation_id,
              tenant_id: ctx.tenant_id,
              dropped,
              raw,
            }),
          );
          const currentTurn = convRow[0]?.turn_count ?? 0;
          const membership = currentEntries.map((e) => e.slug);
          const [catalog, scope] = await Promise.all([
            loadActivationCatalog(ctx.tenant_id, db),
            resolveScopeFactsForConversation(db, ctx.tenant_id, ctx.conversation_id, rawArgs),
          ]);
          const audience = skillAudienceForAuthoringMode(ctx.getDraft().summary?.mode);
          const additions = autoloadForToolCall(
            { tool: inner.name, input: rawArgs, ...scope, audience },
            catalog,
            membership,
          );
          const reaffirmed = new Set(
            reaffirmLoadedForTurn(
              { mode: "tool_call", tool: inner.name, input: rawArgs, ...scope, audience },
              catalog,
              membership,
            ),
          );
          if (additions.length > 0 || reaffirmed.size > 0) {
            const refreshed = currentEntries.map((e) =>
              reaffirmed.has(e.slug) ? { slug: e.slug, last_turn: currentTurn } : e,
            );
            const next = [
              ...refreshed,
              ...additions.map((slug) => ({ slug, last_turn: currentTurn })),
            ];
            await db
              .update(conversations)
              .set({ loaded_skills: next })
              .where(
                and(
                  eq(conversations.tenant_id, ctx.tenant_id),
                  eq(conversations.id, ctx.conversation_id),
                ),
              );
            logger.debug({
              module: "conversations.skill_autoload",
              action: "skill_autoload.applied",
              conversation_id: ctx.conversation_id,
              tool: inner.name,
              added_skills: additions,
              reaffirmed_skills: [...reaffirmed],
            });
          }
        } catch (err) {
          logger.warn({
            module: "conversations.skill_autoload",
            action: "skill_autoload.failed",
            conversation_id: ctx.conversation_id,
            tool: inner.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }

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
        const permCheck: ToolPermissionResult = pregateRefusal
          ? { allow: true }
          : inner.permission
            ? await checkToolPermission(perCallCtx, inner.permission, rawArgs)
            : { allow: true };
        try {
          result =
            pregateRefusal ??
            (permCheck.allow
              ? await withContext(
                  { audit_execution_source: "tool-chain", conversation_id: ctx.conversation_id },
                  () => inner.execute(perCallCtx, resolvedArgs),
                )
              : permissionRefusal(inner, permCheck));
        } catch (err) {
          const failure = describeToolExecutionFailure(err);
          await langfuseSpan.finish({ status: "error", error: failure.span_error });
          const msg = failure.message;
          const output: Record<string, unknown> = failure.output;
          await updateToolCallOutput(db, toolCallId, output, "error");
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
            ...errorFields(err),
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

        const resultPayload: unknown = normalizeToolResultPayload(result);
        const modelSafePayload = hideCapabilityLinks(resultPayload);
        await langfuseSpan.finish({
          output: modelSafePayload,
          status: result.ok ? "success" : "error",
        });
        const skipTruncate = inner.name === "get_raw_result";
        const truncated: TruncatedOutput = skipTruncate
          ? { truncated: false, data: modelSafePayload }
          : truncateForLlm(modelSafePayload);
        const modelVisibleOutput = truncated.truncated
          ? withTruncationMarkers(truncated)
          : modelSafePayload;
        await updateToolCallOutput(
          db,
          toolCallId,
          boundForPersistence(resultPayload, truncated.raw_ref),
          toolCallOutcome(result),
        );
        await autoloadForResultDiagnoses(db, ctx, inner.name, resultPayload);

        if (
          result.ok &&
          inner.category === "draft_write" &&
          inner.captures_draft_snapshot !== false
        ) {
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

        events.push({
          type: "tool_result",
          call_id: toolCallId,
          tool: inner.name,
          output: truncated.truncated ? modelVisibleOutput : resultPayload,
          parent_message_id: assistantMessageId,
        });
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
        const committedWorkflowId = committedWorkflowIdFromResult(result);
        const logCtx = {
          conversation_id: ctx.conversation_id,
          tool: inner.name,
          ok: result.ok,
          paused: Boolean(result.pause),
          committed: Boolean(committedWorkflowId),
          duration_ms: Date.now() - startedAt,
          ...dataSummary,
          ...summarizeToolFailure(result),
        };
        if (result.ok) log.conversation.tool.succeeded(logCtx);
        else log.conversation.tool.failed(logCtx);
        recordConversationToolCall({
          category: inner.category,
          tool: inner.name,
          outcome: result.ok ? "ok" : "error",
          duration_ms: Date.now() - startedAt,
        });
        if (!result.ok) {
          recordConversationToolError({
            tool: inner.name,
            error_code: metricErrorCode(result),
          });
        }

        if (result.ok) {
          signals.toolLastErrorHash.delete(inner.name);
          signals.toolValidationFingerprint.delete(inner.name);
          signals.toolErrorCodeRepeat.delete(inner.name);
          signals.consecutiveFailures = 0;
          if (argsHash && (inner.name === "run_workflow" || inner.name.startsWith("wf_"))) {
            signals.lastExecutionSuccess = {
              tool: inner.name,
              args_hash: argsHash,
              output: resultPayload,
            };
          }
        } else {
          const errObj = (resultPayload ?? {}) as Record<string, unknown>;
          const reason =
            typeof errObj.reason === "string"
              ? errObj.reason
              : typeof errObj.error_code === "string" &&
                  errObj.error_code !== GENERIC_TOOL_FAILURE_CODE
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
          if (reason) {
            const priorCode = signals.toolErrorCodeRepeat.get(inner.name);
            const nextCount = priorCode?.code === reason ? priorCode.count + 1 : 1;
            signals.toolErrorCodeRepeat.set(inner.name, { code: reason, count: nextCount });
          }
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
          const pauseInputRecord =
            inputPayload && typeof inputPayload === "object"
              ? (inputPayload as { pending_output?: Record<string, unknown> })
              : undefined;
          const pausePending =
            pauseInputRecord?.pending_output ??
            (await prepareGate(inner.name, rawArgs, ctx.tenant_id, db, ctx.locale)).pending_output;
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

        if (committedWorkflowId) {
          events.push({ type: "committed", workflow_id: committedWorkflowId });
          log.conversation.completed({
            conversation_id: ctx.conversation_id,
            final_status: "committed",
            committed_workflow_id: committedWorkflowId,
            steps_taken: step + 1,
          });
          signals.committed = { workflow_id: committedWorkflowId };
        }

        if (
          resolvedMode === "confirm_after_execution" &&
          result.ok &&
          !result.pause &&
          !signals.pendingElicitation
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
              actor_id: ctx.engineClient.context.actor_id,
              ...(ctx.engineClient.context.actor_type
                ? { actor_type: ctx.engineClient.context.actor_type }
                : {}),
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
            data: modelVisibleOutput,
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
            ...(committedWorkflowId ? { committed_workflow_id: committedWorkflowId } : {}),
          };
        }

        return {
          ok: result.ok,
          data: modelVisibleOutput,
          ...(result.pause ? { pause: result.pause } : {}),
          ...(committedWorkflowId ? { committed_workflow_id: committedWorkflowId } : {}),
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
