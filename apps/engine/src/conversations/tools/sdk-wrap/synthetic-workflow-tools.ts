// Synthetic `wf_<slug>` tools for the chat palette.
//
// MCP exposes per-tenant saved workflows as first-class `tools/list`
// entries (`wf_<slug>`). The chat LLM needs the same catalog so a
// user message that names a workflow ("run acme-jira-test-plans")
// dispatches in ONE tool call instead of bouncing through
// find_workflow → get_workflow → run_workflow.
//
// Source of truth: `listWorkflowToolsForTenant` in
// `apps/engine/src/workflows/catalog.ts` — MCP and chat read from
// the same function. The `wf_` prefix is added here at the surface.
//
// Dispatch contract mirrors MCP's `tools/call` for `wf_<slug>`:
//   1. `gateWorkflowRunRbac` enforces `workflow:run` before anything runs.
//   2. Durable admission reserves an existing local execution authority, or
//      holds the writes. When the run comes back carrying the mandatory
//      `held_preview_no_writes` warning we mint an UNGRANTED approval over
//      exactly that call's inputs and PAUSE THE TURN on an `ask_user_confirm`
//      elicitation. The turn ending is the gate. A PERSON's answer resumes the
//      conversation: the harness grants the approval on their behalf
//      (`grantApproval`, via the channel they answered through) and only then
//      releases the writes (`persistence/auto-persist.ts` →
//      `commit_held_workflow_writes`), claiming the approval, deriving the
//      workflow from the approval's own tool name, and replaying the encrypted
//      inputs. Four things keep that unreachable from the model:
//      `commit_held_workflow_writes` is not a member of the published
//      `ask_user_*` commit_intent enum; `consumeApproval` claims only a row a
//      human granted, and no model-callable path grants one; the approval id is
//      stripped from every envelope that leaves the engine
//      (`elicitationInputForClient`); and this tool's published schema carries
//      no confirm marker. A model-settable approval marker is an escape hatch,
//      not a gate.
//      There is no pre-execution confirm envelope: `run_workflow` in dev
//      resolves to `no_confirm`, so a gate here would never pause and the
//      writes would never be reachable at all.
//   3. `runExecution({ source: { kind: "saved", workflow_id } })`
//      drives the run. Per-step progress is emitted via `ctx.onLog`
//      the same way `run-workflow.ts` does.
//   4. The envelope mirrors `run_workflow`: `status`, `execution_id`,
//      `output`, `warnings`, `suggested_command: "/workflows run <slug>"`,
//      `next_best_actions`.

import { jsonSchema, type Tool, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { runExecution } from "../../../execution/engine.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../../execution/types.ts";
import { admitWorkflowRun } from "../../../execution/workflow-run-admission.ts";
import { logger } from "../../../logging/logger.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import { requestApproval, stripConfirmMarkers } from "../../../tools/approval.ts";
import {
  listWorkflowToolsForTenant,
  type WorkflowToolDescriptor,
} from "../../../workflows/catalog.ts";
import { workflowExecutionEnvironment } from "../../../workflows/execution-environment.ts";
import { gateWorkflowRunRbac } from "../../../workflows/rbac.ts";
import { createElicitation } from "../../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import { decideToolMode, type PermissionMode, type ToolPolicies } from "../../tool-policies.ts";
import type { TurnEvent } from "../../types.ts";
import { withoutApprovalHandle } from "../ask-user/commit-intent.ts";
import { WORKFLOW_TOOL_PREFIX as TOOL_PREFIX } from "../authoring-palette.ts";
import type { ToolContext } from "../index.ts";
import { sampleWorkflowOutputForLlm } from "../truncate.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

export interface BuildSyntheticWorkflowToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
  permissionMode?: PermissionMode | null;
  toolPolicies?: ToolPolicies;
}

/**
 * Build `wf_<slug>` SDK tools for the principal's tenant. Returned map
 * is keyed by the prefixed name and ready to splice into the AI SDK
 * `toolSet`. Empty when the principal has no saved workflows.
 */
export async function buildSyntheticWorkflowTools(
  p: BuildSyntheticWorkflowToolsParams,
): Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>> {
  const catalog = await listWorkflowToolsForTenant({ db: p.db, principal: p.principal });
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  for (const entry of catalog) {
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
    // AI SDK 7: coerce tool output to JSON-safe for the model (see json-safe-output.ts).
    toModelOutput: jsonSafeModelOutput,
    description: `${entry.description} — perform this saved workflow now. For inspection, repair verification, preview, or preparation for recurring operation use run_workflow with execute_writes: false instead; this tool may pause for a one-shot live execution decision. Dispatches /workflows run ${entry.slug}. Uses a matching local execution authority when one exists and respects stricter approval settings; otherwise write steps resolve without dispatching. If it reports writes_held, nothing was written and the turn pauses for the operator. Do not re-run to bypass that decision.`,
    // The workflow's authored schema, verbatim. No confirm marker: the operator
    // — not the model — releases the held writes, through the elicitation this
    // tool raises. A model-settable approval slot would be the escape hatch.
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
  // Defence in depth — production callers always source ctx.tenant_id
  // and principal.tenant_id from the same auth resolution, so a mismatch
  // means an upstream refactor broke that invariant. Better to fail
  // loud at the dispatch boundary than to write audit / execution rows
  // for the wrong tenant.
  if (ctx.tenant_id !== principal.tenant_id) {
    throw new Error(
      `synthetic wf_<slug> dispatch: ctx.tenant_id (${ctx.tenant_id}) !== principal.tenant_id (${principal.tenant_id})`,
    );
  }
  // Mirrors fast-path's actor_id invariant warning. Authenticated
  // production calls always carry both `principal` and `ctx.actor_id`
  // from the same auth resolution; if a user-kind principal arrives
  // without an actor_id the audit row will fall back to actor_type=system,
  // and operators should see the diagnostic instead of silently
  // mis-attributing the dispatch.
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
  // Canonical RBAC gate — identical contract to MCP's `wf_<slug>`
  // dispatch and the fast-path "run <slug>" branch. A POLICY_DENIED
  // audit row is committed before this returns so an operator denied
  // here sees the same evidence trail an MCP denial produces.
  const rbac = await gateWorkflowRunRbac({
    db,
    principal,
    workflow_id: entry.workflow_id,
    workflow_slug: entry.slug,
    request_source: "chat",
    tool: name,
  });
  if (!rbac.allow) {
    const output: Record<string, unknown> = {
      ok: false,
      denied: true,
      permission: "workflow:run",
      reason: rbac.reason,
      error: rbac.error_message,
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
  // A model-supplied marker cannot create authority. Admission below reserves
  // a matching human-granted boundary or persists held preparation. The older
  // one-shot review path is separate; it never extends the standing grant.
  const workflowInput = stripConfirmMarkers(rawArgs);

  // Anchor an assistant message + tool-call row so this synthetic
  // dispatch shows up in the same persisted trail real tool calls
  // produce. `signals.assistantMessageId` is the per-turn anchor every
  // sibling wrapper reuses; we ensure it's set the same way.
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

  const inputForRun = Object.keys(workflowInput).length > 0 ? workflowInput : null;

  try {
    const environment = await workflowExecutionEnvironment(db, ctx.tenant_id, entry.workflow_id);
    ctx.onLog?.("info", `running workflow ${entry.slug} in env=${environment}`);
    const policies = p.toolPolicies ?? {};
    const specificPolicy = policies[name] ?? policies.run_workflow;
    const decision = decideToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { environment },
      overrides: specificPolicy ? { run_workflow: specificPolicy } : {},
      permission_mode: p.permissionMode ?? ctx.permission_mode ?? null,
    });
    const admitted = await admitWorkflowRun(
      {
        tenant_id: ctx.tenant_id,
        workflow_id: entry.workflow_id,
        execution_environment: environment,
        request_source: "chat",
        input: inputForRun,
        ...(decision.mode !== "no_confirm" ? { hold_writes: true } : {}),
      },
      db,
    );
    const result = await runExecution({
      db,
      tenant_id: ctx.tenant_id,
      source: {
        kind: "saved",
        workflow_id: entry.workflow_id,
        version_id: admitted.workflow_version_id,
      },
      input: admitted.input,
      options: {
        request_source: "chat",
        trace_id: null,
        principal,
        execution_mode: environment,
        existing_execution_id: admitted.execution_id,
        hold_writes: admitted.hold_writes,
      },
    });
    // Mirror run-workflow.ts:306-329 per-step log emission so the user
    // sees identical progress whether the LLM picked `wf_<slug>` or the
    // fallback `run_workflow`.
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
    // Did this run hold a write? A read-only workflow emits no held-preview
    // warning and so never mints an approval nor pauses the turn.
    const heldPreview = result.warnings?.find((w) => w.code === HELD_PREVIEW_WARNING_CODE);
    // Same-turn dedupe, mirroring invoke.ts's policy gate: a second pending
    // elicitation in one turn would supersede the first (createElicitation
    // cancels stale rows) and strand its approval. Refuse before minting.
    if (heldPreview && signals.pendingElicitation) {
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
    // Persist the inputs this preview ran with, encrypted, under a single-use
    // approval id. The id NEVER reaches the model — it rides on the
    // elicitation's commit_intent, and the harness claims it after the
    // operator answers (persistence/auto-persist.ts).
    let approvalId: string | null = null;
    let approvalUrl: string | null = null;
    if (heldPreview) {
      approvalId = crypto.randomUUID();
      const requested = await requestApproval({
        db,
        principal,
        approval_id: approvalId,
        tool: name,
        surface: "chat",
        via: "chat",
        // Not a policy-table verdict: the RUN held its writes.
        reason: "held_writes",
        // Use the same schedule environment that admission and execution checked.
        execution_mode: environment,
        args: workflowInput,
        prepared_execution_id: result.execution_id,
        // Chat reaches a human in-band, so the portal is a fallback here rather
        // than the only channel — but an approval is approvable from either, and
        // both must show the same writes.
        preview: heldDetails,
      });
      // The minted link used to be discarded outright, so an operator who could
      // not answer in-band had no channel at all and the portal's completion
      // bridge could not recognise the row.
      approvalUrl = requested.approval_url ?? null;
    }
    const output: Record<string, unknown> = {
      // A preview reports the reads that ran, never a completed action. `ok:
      // false` keeps the model from narrating "sent" for a run that held
      // every write, while `status` stays the honest execution status.
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
      // A held preview has NO next action for the model: the turn ends here and
      // the operator decides. Re-running only reproduces the preview.
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
      output,
    });
    // Model-visible envelope: the workflow output rides SAMPLED (mirrors
    // run_workflow's envelope, same output_sampled markers the truncator
    // protects). The full envelope above stays on the audit rows; pre-fix
    // the raw output went back to the SDK unbounded and re-rode the
    // cumulative prompt on every subsequent step of the turn.
    const sampledOutput = sampleWorkflowOutputForLlm(result.output);
    const modelOutput: Record<string, unknown> = {
      ...output,
      output: sampledOutput.value,
      ...(sampledOutput.sampled
        ? {
            output_sampled: true,
            output_note: `output is a sample (in-band "… sampled N of M" markers mark the cut points); full payload via get_raw_result(ref="${sampledOutput.raw_ref}") or inspect_execution_step. Present the sampled rows to the user directly — do NOT re-run the workflow to "get" the output.`,
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
    // The turn ENDS here when a write was held. `signals.pendingElicitation`
    // makes runLoop resolve the turn as `awaiting_input`; the `pause` on the
    // returned envelope trips `pausedStopCondition` so the SDK stops calling
    // the model in this step. Between them the model cannot re-enter this tool
    // — or any other — until a human answers. The commit_intent is what the
    // harness dispatches on that answer.
    let pause: WrappedToolOutput["pause"];
    if (heldPreview && approvalId) {
      const heldCount = wouldWrite.length || heldSteps.length;
      const summary = `Run ${heldCount} held write step(s) of "${entry.slug}"`;
      // `payload` carries the CAS predicate and the handle, nothing else: the
      // workflow that runs is derived from the approval's own `tool` on claim
      // (`persistence/auto-persist.ts`). A target field here would be a field an
      // attacker could set.
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
      // The handle stays on the persisted row the harness reads. Everything that
      // leaves this process — the SDK tool-result the model is shown, the
      // `elicit_request` frame, the pause envelope `conversation_get` relays —
      // carries the same prompt minus the capability.
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
          actor_id: ctx.actor_id,
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
    // Mirror run-workflow.ts so chat-via-`wf_<slug>` and
    // chat-via-`run_workflow` are observationally indistinguishable:
    //   1. `conversation.run_workflow` audit row (operators searching
    //      by this action surface both paths together);
    //   2. `target_workflow_id` on the conversation (so "run it again"
    //      heuristics in `service/run-turn.ts` still resolve);
    //   3. `conversation_tool_calls_total` counter.
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system",
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
    await db
      .update(conversations)
      .set({ target_workflow_id: entry.workflow_id, updated_at: new Date() })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      // A held preview awaits the operator's confirmation — counting it as a
      // completed run would skew the run-vs-pending ratio the same way the
      // fast-path pending envelope would.
      outcome: heldPreview ? "pending" : ok ? "ok" : "error",
      duration_ms: 0,
    });
    return {
      ok: heldPreview ? false : ok,
      data: modelOutput,
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
