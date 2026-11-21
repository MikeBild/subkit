import { jsonSchema, type Tool, tool } from "ai";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { admittedCoveringAuthority } from "../../../execution/core/run-coverage.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../../execution/types.ts";
import { completedRun, createRunWorkflow } from "../../../execution/use-cases/run-workflow.ts";
import { logger } from "../../../logging/index.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import { stripConfirmMarkers } from "../../../tools/approval.ts";
import { policyDecide } from "../../../tools/policy.ts";
import { sampleWorkflowOutputForLlm } from "../../../tools/truncate.ts";
import type { ToolPolicies } from "../../../tools/types.ts";
import {
  listWorkflowToolsForTenant,
  type WorkflowToolDescriptor,
} from "../../../workflows/catalog.ts";
import { workflowExecutionEnvironment } from "../../../workflows/execution-environment.ts";
import {
  type GateRecordInput,
  gateRecordFor,
  logGateDecision,
  openHeldWritesApproval,
  recordConfirmationSkipped,
  writesModelUnchecked,
} from "../../confirmation.ts";
import { createElicitation } from "../../elicitations.ts";
import { executionSuppressionRefusal } from "../../execution-suppression.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persistence/index.ts";
import { taskRunToolPolicies } from "../../tool-policies.ts";
import type { TaskRunMarker, TurnEvent } from "../../types.ts";
import { withoutApprovalHandle } from "../ask-user/commit-intent.ts";
import { WORKFLOW_TOOL_PREFIX as TOOL_PREFIX } from "../authoring-palette.ts";
import { hideCapabilityLinks } from "../capability-link.ts";
import type { ToolContext } from "../index.ts";
import { executionDataTransfer } from "./gate-subjects.ts";
import { loadRunCoverage, workflowConfirmOverride } from "./invoke/run-coverage.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";
import { taskRunMarkerOf, taskRunWorkflowRefusal } from "./task-run-guard.ts";

export interface BuildSyntheticWorkflowToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
  toolPolicies?: ToolPolicies;
  taskRun?: TaskRunMarker | null;
}

function boundToTaskRun(taskRun: TaskRunMarker | null | undefined, workflow_id: string): boolean {
  return !taskRun || (!taskRun.sealed && taskRun.workflow_ids.includes(workflow_id));
}

export async function buildSyntheticWorkflowTools(
  p: BuildSyntheticWorkflowToolsParams,
): Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>> {
  const catalog = await listWorkflowToolsForTenant({
    db: p.db,
    principal: p.principal,
    request_source: "chat",
    ...(p.taskRun && !p.taskRun.sealed ? { bound_workflow_ids: p.taskRun.workflow_ids } : {}),
  });
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  for (const entry of catalog) {
    if (!boundToTaskRun(p.taskRun, entry.workflow_id)) continue;
    const name = `${TOOL_PREFIX}${entry.slug}`;
    out[name] = buildOneSyntheticWorkflowTool({ ...p, entry, name });
  }
  return out;
}

interface BuildOneParams extends BuildSyntheticWorkflowToolsParams {
  entry: WorkflowToolDescriptor;
  name: string;
}

function buildOneSyntheticWorkflowTool(
  p: BuildOneParams,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  const { entry, signals } = p;
  return tool<Record<string, unknown>, WrappedToolOutput, Record<string, unknown>>({
    toModelOutput: jsonSafeModelOutput,
    description: `${entry.description} — perform this saved workflow now. For inspection of an existing run use read-only execution history, get_execution, inspect_execution_step or diagnose_latest_execution. For a new preview use run_workflow with execute_writes: false; this still starts a DEV run. Do not use this tool or any preview tool when the user says not to run, execute, test-run or start a workflow. This tool may pause for a one-shot live execution decision. Dispatches /workflows run ${entry.slug}. Uses a matching local execution authority when one exists and respects stricter approval settings; otherwise write steps resolve without dispatching. If it reports writes_held, nothing was written and the turn pauses for the operator. Do not re-run to bypass that decision.`,
    inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
    async execute(rawArgs: Record<string, unknown>): Promise<WrappedToolOutput> {
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      try {
        return await executeSyntheticRun({ ...p, rawArgs });
      } finally {
        release();
      }
    },
  });
}

async function executeSyntheticRun(
  p: BuildOneParams & { rawArgs: Record<string, unknown> },
): Promise<WrappedToolOutput> {
  const { entry, ctx, signals, events, db, name, principal, rawArgs } = p;
  const taskRun = p.taskRun ?? taskRunMarkerOf(ctx);
  if (!boundToTaskRun(taskRun, entry.workflow_id)) {
    const refused = taskRunWorkflowRefusal();
    return { ok: false, data: refused.data };
  }
  const suppressionRefusal = await executionSuppressionRefusal({
    db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    recent_user_message: ctx.recentUserMessage ?? null,
    live_tool: true,
  });
  if (suppressionRefusal) return { ok: false, data: suppressionRefusal };
  if (ctx.tenant_id !== principal.tenant_id) {
    throw new Error(
      `synthetic wf_<slug> dispatch: ctx.tenant_id (${ctx.tenant_id}) !== principal.tenant_id (${principal.tenant_id})`,
    );
  }
  if (ctx.actor_id === null && principal.kind === "user") {
    logger.warn({
      module: "conversation_tool",
      action: "wf_synthetic.actor_id_missing",
      msg: "synthetic wf_<slug> dispatch with user-kind principal but actor_id=null — audit row will fall back to actor_type=system",
      tenant_id: ctx.tenant_id,
      principal_id: principal.id,
      tool: name,
    });
  }
  const useCase = createRunWorkflow({ db });
  const grant = await useCase.authorize({
    principal,
    workflow_id: entry.workflow_id,
    workflow_slug: entry.slug,
    via: "chat",
    tool: name,
  });
  if (grant.kind === "rejected") {
    const output: Record<string, unknown> = {
      ok: false,
      denied: true,
      permission: "workflow:run",
      reason: grant.reason,
      error: grant.message,
      status: "failed",
    };
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "denied",
      duration_ms: 0,
    });
    return { ok: false, data: output };
  }
  const workflowInput = stripConfirmMarkers(rawArgs);

  const ensureAnchor = async (): Promise<string> => {
    if (signals.assistantMessageId) return signals.assistantMessageId;
    const messageId = await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "assistant", {});
    signals.assistantMessageId = messageId;
    return messageId;
  };
  const assistantMessageId = await ensureAnchor();
  const toolCallId = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    parent_message_id: assistantMessageId,
    tool: name,
    input: workflowInput,
    approval_required: false,
  });
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: name,
    input_partial: workflowInput,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: workflowInput,
    parent_message_id: assistantMessageId,
  });

  const inputForRun = Object.keys(workflowInput).length > 0 ? workflowInput : undefined;

  try {
    const environment = taskRun
      ? taskRun.environment
      : await workflowExecutionEnvironment(db, ctx.tenant_id, entry.workflow_id);
    ctx.onLog?.("info", `running workflow ${entry.slug} in env=${environment}`);
    const policies = taskRun ? taskRunToolPolicies(p.toolPolicies ?? {}) : (p.toolPolicies ?? {});
    const specificPolicy = policies[name] ?? policies.run_workflow;
    const askBeforeWriting = !taskRun && ctx.ask_before_writing === true;
    const transfersExecutionData =
      (await executionDataTransfer(workflowInput, ctx.tenant_id, db)) !== null;
    const coverage = await loadRunCoverage(db, askBeforeWriting, () =>
      workflowConfirmOverride(policies, entry.slug)
        ? null
        : {
            tenant_id: ctx.tenant_id,
            workflow_id: entry.workflow_id,
            execution_environment: environment,
          },
    );
    const decision = policyDecide({
      tool: "run_workflow",
      category: "tenant_write",
      surface: "chat",
      args: { environment },
      ...(transfersExecutionData ? { execution_data_transfer: true } : {}),
      ...(coverage.covered ? { authority_covered: true } : {}),
      ...(taskRun ? { task_run: true } : {}),
      ...(!taskRun && writesModelUnchecked(ctx.tenant_id, askBeforeWriting)
        ? { model_checked: false }
        : {}),
      overrides: specificPolicy ? { run_workflow: specificPolicy } : {},
      ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    });
    const gateRecordInput: GateRecordInput = {
      approval_tool: name,
      category: "tenant_write",
      record_surface: ctx.surface ?? "api",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    };
    const holdWrites = decision.mode !== "no_confirm";
    if (!holdWrites) logGateDecision(gateRecordFor(gateRecordInput, decision, "proceed"));
    const outcome = await useCase.runWorkflow({
      principal,
      workflow_id: entry.workflow_id,
      execution_environment: environment,
      request_source: "chat",
      input: inputForRun,
      ...(holdWrites ? { hold_writes: true } : {}),
      authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
      audit_extra: { tool: name },
      dispatch: { mode: "inline", trace_id: null },
    });
    const { admitted, result } = completedRun(outcome);
    for (const step of result.steps) {
      const errMsg =
        step.error && typeof step.error === "object" && step.error !== null
          ? (step.error as { message?: unknown }).message
          : null;
      const level: "info" | "warn" | "error" =
        step.status === "succeeded"
          ? "info"
          : step.status === "failed" || step.status === "timed_out"
            ? "error"
            : "warn";
      ctx.onLog?.(
        level,
        `step ${step.step_key} (${step.kind}) ${step.status}${
          step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""
        }${typeof errMsg === "string" ? ` · ${errMsg}` : ""}`,
      );
    }
    for (const w of result.warnings ?? []) {
      ctx.onLog?.(
        "warn",
        `step ${w.step_key} · ${w.code}${w.identifier ? ` · ${w.identifier}` : ""} · ${w.message}`,
      );
    }
    const ok = result.status === "succeeded";
    const heldPreview = result.warnings?.find((w) => w.code === HELD_PREVIEW_WARNING_CODE);
    if (heldPreview && signals.pendingElicitation) {
      logGateDecision(gateRecordFor(gateRecordInput, decision, "duplicate_pending"));
      const dupOutput: Record<string, unknown> = {
        ok: false,
        status: result.status,
        error_code: "duplicate_pending_elicitation_in_turn",
        error: `Another tool call in this turn already paused for the operator (${signals.pendingElicitation.tool_name}). Nothing was written by ${name}. Wait for the user to answer, then start again.`,
        workflow_id: entry.workflow_id,
        workflow_slug: entry.slug,
      };
      await updateToolCallOutput(db, toolCallId, dupOutput, "denied");
      events.push({
        type: "tool_result",
        call_id: toolCallId,
        tool: name,
        output: dupOutput,
        parent_message_id: assistantMessageId,
      });
      recordConversationToolCall({
        category: "tenant_write",
        tool: name,
        outcome: "denied",
        duration_ms: 0,
      });
      return { ok: false, data: dupOutput };
    }
    const heldDetails = (heldPreview?.details ?? {}) as {
      held_steps?: unknown;
      would_write?: unknown;
    };
    const heldSteps = Array.isArray(heldDetails.held_steps) ? heldDetails.held_steps : [];
    const wouldWrite = Array.isArray(heldDetails.would_write) ? heldDetails.would_write : [];
    let approvalId: string | null = null;
    let approvalUrl: string | null = null;
    if (heldPreview) {
      const opened = await openHeldWritesApproval({
        db,
        principal,
        tool: name,
        args: workflowInput,
        environment,
        prepared_execution_id: result.execution_id,
        preview: heldDetails,
        conversation_id: ctx.conversation_id,
        actor_id: ctx.actor_id,
        record_surface: gateRecordInput.record_surface,
        decision,
      });
      approvalId = opened.approval_id;
      approvalUrl = opened.approval_url;
    } else if (holdWrites) {
      logGateDecision(gateRecordFor(gateRecordInput, decision, "proceed"));
    }
    const output: Record<string, unknown> = {
      ok: heldPreview ? false : ok,
      status: result.status,
      execution_id: result.execution_id,
      workflow_version_id: admitted.workflow_version_id,
      execution_authority_id: admitted.execution_authority_id,
      hold_writes: admitted.hold_writes,
      workflow_id: entry.workflow_id,
      workflow_slug: entry.slug,
      output: result.output,
      warnings: result.warnings ?? [],
      suggested_command: `/workflows run ${entry.slug}`,
      next_best_actions: heldPreview
        ? []
        : result.status === "succeeded"
          ? ["inspect_execution_step", "run_workflow"]
          : ["diagnose_latest_execution", "inspect_workflow"],
      ...(result.error ? { error: result.error } : {}),
      ...(heldPreview
        ? {
            pending: true,
            policy_mode: "confirm_before_execution",
            awaiting_operator_approval: true,
            preview: true,
            writes_held: true,
            message: heldPreview.message,
            held_steps: heldSteps,
            would_write: wouldWrite,
            resume: `Nothing was written. ${wouldWrite.length || heldSteps.length} write step(s) are held and this turn is over: the operator must approve them. When they do, the engine performs them itself and reports back — you do not re-issue ${name}, and you cannot approve on the user's behalf.`,
          }
        : {}),
    };
    await updateToolCallOutput(
      db,
      toolCallId,
      output,
      heldPreview ? "pending" : ok ? "ok" : "error",
    );
    await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
      tool: name,
      output: hideCapabilityLinks(output),
    });
    const sampledOutput = sampleWorkflowOutputForLlm(result.output);
    const modelOutput: Record<string, unknown> = {
      ...output,
      output: sampledOutput.value,
      ...(sampledOutput.sampled
        ? {
            output_sampled: true,
            output_note: `output is a sample (in-band "… sampled N of M" markers mark the cut points); retrieve larger payloads via get_raw_result(ref="${sampledOutput.raw_ref}") and follow its bounded field retrieval instructions, or use inspect_execution_step. Present the sampled rows to the user directly — do NOT re-run the workflow to "get" the output.`,
            ...(sampledOutput.raw_ref ? { output_raw_ref: sampledOutput.raw_ref } : {}),
          }
        : {}),
    };
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output: modelOutput,
      parent_message_id: assistantMessageId,
    });
    let pause: WrappedToolOutput["pause"];
    if (heldPreview && approvalId) {
      const heldCount = wouldWrite.length || heldSteps.length;
      const summary = `Run ${heldCount} held write step(s) of "${entry.slug}"`;
      const elicitationInput: Record<string, unknown> = {
        kind: "external_write",
        question: `Workflow "${entry.slug}" previewed ${heldCount} write step(s) — nothing has been written yet. Perform them now?`,
        target: { tool: name, workflow_slug: entry.slug },
        risk_level: "high",
        reversible: false,
        pending_output: { held_steps: heldSteps, would_write: wouldWrite },
        ...(approvalUrl ? { approval_url: approvalUrl } : {}),
        commit_intent: {
          kind: "commit_held_workflow_writes",
          payload: { tool: name, approval_id: approvalId },
          description: `Perform the ${heldCount} held write step(s) of workflow ${entry.slug}.`,
        },
      };
      const operatorInput = withoutApprovalHandle(elicitationInput);
      const elicitation = await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tool_call_id: toolCallId,
          parent_message_id: assistantMessageId,
          tool_name: "ask_user_confirm",
          summary,
          input: elicitationInput,
          actor_id: principal.id,
          actor_type: principal.kind,
        },
        db,
      );
      signals.pendingChildElicitationIds.push(elicitation.id);
      events.push({
        type: "elicit_request",
        elicitation_id: elicitation.id,
        tool_call_id: toolCallId,
        tool_name: "ask_user_confirm",
        summary,
        input: operatorInput,
        parent_message_id: assistantMessageId,
        pending_output: { held_steps: heldSteps, would_write: wouldWrite },
      });
      signals.pendingElicitation = {
        elicitation_id: elicitation.id,
        tool_name: "ask_user_confirm",
        kind: "external_write",
        summary,
        input: operatorInput,
      };
      pause = {
        tool_name: "ask_user_confirm",
        kind: "external_write",
        summary,
        elicitation_id: elicitation.id,
        input: operatorInput,
      };
    }
    logger.info({
      module: "conversation_tool",
      action: "wf_synthetic.executed",
      msg: "wf_<slug> synthetic tool ran",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: name,
      workflow_id: entry.workflow_id,
      status: result.status,
      preview: heldPreview !== undefined,
      writes_held: heldPreview !== undefined,
      execution_authority_id: admitted.execution_authority_id,
      paused_for_operator: pause !== undefined,
    });
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.EXECUTION_STARTED,
        resource_type: "execution",
        resource_id: result.execution_id,
        result: ok ? "success" : "error",
        metadata: {
          via_action: "conversation.run_workflow",
          conversation_id: ctx.conversation_id,
          workflow_id: entry.workflow_id,
          tool: name,
          environment,
          final_status: result.status,
          workflow_version_id: admitted.workflow_version_id,
          execution_authority_id: admitted.execution_authority_id,
          hold_writes: admitted.hold_writes,
          writes_held: heldPreview !== undefined,
        },
      },
      db,
    );
    if (coverage.covered && admittedCoveringAuthority(decision.rule, coverage, admitted) !== null) {
      await recordConfirmationSkipped({
        db,
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        tool_call_id: toolCallId,
        tool: name,
        environment: coverage.environment,
        covering_authority_id: coverage.authority_id,
        actor_id: principal.id,
        actor_type: principal.kind,
      });
    }
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: heldPreview ? "pending" : ok ? "ok" : "error",
      duration_ms: 0,
    });
    return {
      ok: heldPreview ? false : ok,
      data: hideCapabilityLinks(modelOutput) as Record<string, unknown>,
      ...(pause ? { pause } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      workflow_id: entry.workflow_id,
      workflow_slug: entry.slug,
      error: msg,
      error_code:
        typeof (err as { code?: unknown })?.code === "string"
          ? (err as { code: string }).code
          : "workflow_run_failed",
    };
    await updateToolCallOutput(db, toolCallId, output, "error");
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    logger.warn({
      module: "conversation_tool",
      action: "wf_synthetic.failed",
      msg: "wf_<slug> synthetic tool threw",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: name,
      workflow_id: entry.workflow_id,
      error: msg,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "error",
      duration_ms: 0,
    });
    return { ok: false, data: output };
  }
}
