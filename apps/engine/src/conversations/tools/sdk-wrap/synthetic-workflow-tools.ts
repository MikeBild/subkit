// Synthetic `wf_<slug>` tools for the chat palette.
//
// MCP exposes per-tenant saved workflows as first-class `tools/list`
// entries (`wf_<slug>`). The chat LLM needs the same catalog so a
// user message that names a workflow ("run emobxp-jira-test-plans")
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
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { runExecution } from "../../../execution/engine.ts";
import { logger } from "../../../logging/logger.ts";
import { gateTenantToolCall } from "../../../mcp/capabilities/policy-gate.ts";
import {
  listWorkflowToolsForTenant,
  type WorkflowToolDescriptor,
} from "../../../workflows/catalog.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

const TOOL_PREFIX = "wf_";

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
  return tool<Record<string, unknown>, WrappedToolOutput>({
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
  // Policy gate — identical contract to MCP and the regular `run_workflow`
  // tool. The LLM re-issues with `__policy_confirmed: true` after the
  // operator confirms.
  const gate = await gateTenantToolCall({
    tool: "run_workflow",
    category: "tenant_write",
    args: { ...rawArgs, workflow: entry.slug, environment: "dev" },
    meta: undefined,
    principal,
    db,
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
    return { ok: false, data: output };
  }

  // Strip the marker before handing the args to runExecution so its
  // input contract stays clean.
  const { __policy_confirmed: _confirmed, ...workflowInput } = rawArgs;
  const inputForRun = Object.keys(workflowInput).length > 0 ? workflowInput : null;

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
    return { ok: false, data: output };
  }
}
