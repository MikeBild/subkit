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
// Dispatch contract is identical to MCP's `tools/call` for `wf_<slug>`:
//   1. `gateTenantToolCall` enforces RBAC + confirm-before-execution.
//      A pending envelope is surfaced verbatim — the operator confirms,
//      the LLM re-issues with `__policy_confirmed: true`, the second
//      call proceeds.
//   2. `runExecution({ source: { kind: "saved", workflow_id } })`
//      drives the run. Per-step progress is emitted via `ctx.onLog`
//      the same way `run-workflow.ts` does.
//   3. The envelope mirrors `run_workflow`: `status`, `execution_id`,
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
import { logger } from "../../../logging/logger.ts";
import { gateTenantToolCall } from "../../../mcp/capabilities/policy-gate.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import {
  listWorkflowToolsForTenant,
  type WorkflowToolDescriptor,
} from "../../../workflows/catalog.ts";
import { gateWorkflowRunRbac } from "../../../workflows/rbac.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import type { TurnEvent } from "../../types.ts";
import { WORKFLOW_TOOL_PREFIX as TOOL_PREFIX } from "../authoring-palette.ts";
import type { ToolContext } from "../index.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

export interface BuildSyntheticWorkflowToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
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
    description: `${entry.description} — saved workflow, runs in dev. Dispatches /workflows run ${entry.slug}.`,
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
  // Policy gate — identical contract to MCP and the regular `run_workflow`
  // tool. The LLM re-issues with `__policy_confirmed: true` after the
  // operator confirms. `tool` stays `run_workflow` so `resolveToolMode`
  // applies the same dev → no_confirm shortcut MCP uses (the policy
  // registry doesn't know `wf_<slug>` names). The specific slug surfaces
  // in audit metadata via `subject_workflow_slug` so operators can still
  // filter approvals by saved workflow.
  const gate = await gateTenantToolCall({
    tool: "run_workflow",
    category: "tenant_write",
    args: { ...rawArgs, workflow: entry.slug, environment: "dev" },
    meta: undefined,
    principal,
    db,
    via: "chat",
    subject_workflow_slug: entry.slug,
  });

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
    input: rawArgs,
    approval_required: false,
  });
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: name,
    input_partial: rawArgs,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: rawArgs,
    parent_message_id: assistantMessageId,
  });

  if (gate.kind === "pending") {
    const output: Record<string, unknown> = {
      pending: true,
      status: "awaiting_confirmation",
      policy_mode: "confirm_before_execution",
      confirm_required: true,
      target: gate.envelope.target,
      tool_call_id: gate.envelope.tool_call_id,
      resume: gate.envelope.resume,
      workflow_slug: entry.slug,
      suggested_command: `/workflows run ${entry.slug}`,
    };
    await updateToolCallOutput(db, toolCallId, output);
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "pending",
      duration_ms: 0,
    });
    return { ok: false, data: output };
  }

  // Strip the marker before handing the args to runExecution so its
  // input contract stays clean.
  const { __policy_confirmed: confirmed, ...workflowInput } = rawArgs;
  const inputForRun = Object.keys(workflowInput).length > 0 ? workflowInput : null;

  // HOLD write-classified steps unless this run was explicitly
  // confirmed. In dev the policy resolves to `no_confirm`, so without this a
  // chat `wf_<slug>` would dispatch real sends silently — the exact way an
  // MCP `wf_<slug>` once mailed stale snapshots during a live authoring
  // session. A confirmed run (`__policy_confirmed: true`, set when the user
  // approves the pending envelope) IS the explicit "send for real" signal;
  // an unconfirmed dev run resolves + holds the writes so verification is
  // side-effect-safe. Keeps this surface consistent with `run_workflow` and
  // the MCP `wf_<slug>` hold-by-default contract.
  const executeWrites = confirmed === true;

  ctx.onLog?.("info", `running workflow ${entry.slug} in env=dev`);
  try {
    const result = await runExecution({
      db,
      tenant_id: ctx.tenant_id,
      source: { kind: "saved", workflow_id: entry.workflow_id },
      input: inputForRun,
      options: {
        request_source: "chat",
        trace_id: null,
        principal,
        execution_mode: "dev",
        ...(executeWrites ? {} : { hold_writes: true }),
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
    const output: Record<string, unknown> = {
      ok,
      status: result.status,
      execution_id: result.execution_id,
      workflow_id: entry.workflow_id,
      workflow_slug: entry.slug,
      output: result.output,
      warnings: result.warnings ?? [],
      suggested_command: `/workflows run ${entry.slug}`,
      next_best_actions:
        result.status === "succeeded"
          ? ["inspect_execution_step", "run_workflow"]
          : ["diagnose_latest_execution", "inspect_workflow"],
      ...(result.error ? { error: result.error } : {}),
    };
    await updateToolCallOutput(db, toolCallId, output);
    await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
      tool: name,
      output,
    });
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    logger.info({
      module: "conversation_tool",
      action: "wf_synthetic.executed",
      msg: "wf_<slug> synthetic tool ran",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: name,
      workflow_id: entry.workflow_id,
      status: result.status,
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
          environment: "dev",
          final_status: result.status,
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
      outcome: ok ? "ok" : "error",
      duration_ms: 0,
    });
    return { ok, data: output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      workflow_id: entry.workflow_id,
      workflow_slug: entry.slug,
      error: msg,
    };
    await updateToolCallOutput(db, toolCallId, output);
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
