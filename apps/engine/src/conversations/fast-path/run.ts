import { connectorEnvironmentKey, getConnectorsForEnvironments } from "../../connectors/service.ts";
import type { ExecutionMode } from "../../execution/types.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../execution/types.ts";
import {
  authorizeWorkflowRun,
  completedRun,
  createRunWorkflow,
  type RunGrant,
  type RunRefusal,
} from "../../execution/use-cases/run-workflow.ts";
import { logger } from "../../logging/logger.ts";
import { confirmEnvelopeFor } from "../../tools/policy.ts";
import { resolveWorkflowReviewEnvironment } from "../../workflows/execution-environment.ts";
import { resolveWorkflowInputContract } from "../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { runConfirmGate } from "../confirmation.ts";
import {
  decideRunEnvironment,
  type EnvironmentResolution,
  gateSurfaceFor,
  runNextActions,
  runReply,
} from "../core/fast-path.ts";
import type { RenderPayload } from "../fast-path-lists.ts";
import type { ToolCallOutcome } from "../tools/result-payload.ts";
import { prepareGate } from "../tools/sdk-wrap/gate-subjects.ts";
import { answerFastPath } from "./persist.ts";
import type { FastPathHit, FastPathParams } from "./types.ts";

export interface RunTarget {
  id: string;
  slug: string;
  name: string;
  current_version_id: string | null;
}

async function devBindings(
  p: FastPathParams,
  references: readonly { connector_id: string | null }[],
): Promise<(ExecutionMode | null)[]> {
  const connector_ids = [
    ...new Set(references.flatMap((reference) => reference.connector_id ?? [])),
  ];
  const rows = await getConnectorsForEnvironments(
    p.tenant_id,
    connector_ids.map((connector_id) => ({ connector_id, environment: "dev" as const })),
    p.db,
  );
  return connector_ids.map(
    (connector_id) => rows.get(connectorEnvironmentKey(connector_id, "dev"))?.environment ?? null,
  );
}

async function fastPathEnvironment(
  p: FastPathParams,
  workflow: RunTarget,
  references: readonly { connector_id: string | null }[],
): Promise<ExecutionMode | null> {
  let resolution: EnvironmentResolution;
  try {
    const review = await resolveWorkflowReviewEnvironment(p.db, p.tenant_id, workflow.id, {
      version_id: workflow.current_version_id,
    });
    resolution =
      review.source === "default"
        ? { kind: "default", dev_bindings: await devBindings(p, references) }
        : { kind: "resolved", environment: review.environment };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "workflow_environment_ambiguous") throw error;
    resolution = { kind: "ambiguous" };
  }
  return decideRunEnvironment(resolution);
}

async function executeRunWorkflow(
  p: FastPathParams,
  wf: RunTarget,
  grant: RunGrant,
  environment: ExecutionMode,
): Promise<RenderPayload & { outcome: ToolCallOutcome }> {
  if (p.actor_id === null) {
    logger.warn({
      module: "conversation",
      action: "fast_path.actor_id_missing",
      msg: "fast-path executeRunWorkflow invoked with actor_id=null — audit row will fall back to actor_type=system",
      tenant_id: p.tenant_id,
      principal_id: p.principal.id,
    });
  }
  try {
    const { admitted, result } = completedRun(
      await createRunWorkflow({ db: p.db }).runWorkflow({
        principal: p.principal,
        workflow_id: wf.id,
        workflow_version_id: wf.current_version_id ?? undefined,
        execution_environment: environment,
        request_source: "chat",
        input: null,
        authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
        audit_extra: { via: "fast_path" },
        dispatch: { mode: "inline", trace_id: null },
      }),
    );
    const { ok, held_preview, reply } = runReply(
      wf.slug,
      p.user_message,
      result,
      HELD_PREVIEW_WARNING_CODE,
    );
    return {
      ok,
      outcome: result.status === "succeeded" ? "ok" : "error",
      reply,
      data: {
        status: result.status,
        execution_id: result.execution_id,
        workflow_id: wf.id,
        workflow_slug: wf.slug,
        workflow_version_id: admitted.workflow_version_id,
        execution_authority_id: admitted.execution_authority_id,
        hold_writes: admitted.hold_writes,
        ...(held_preview ? { preview: true, writes_held: true } : {}),
        output: result.output,
        warnings: result.warnings ?? [],
        suggested_command: `/workflows run ${wf.slug}`,
        next_best_actions: runNextActions(result.status),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      outcome: "error",
      reply: `Run of ${wf.slug} failed: ${msg}`,
      data: { status: "failed", workflow_id: wf.id, error: msg },
    };
  }
}

export function denyRun(
  p: FastPathParams,
  input: Record<string, unknown>,
  grant: RunRefusal,
): Promise<FastPathHit> {
  return answerFastPath(p, {
    tool: "run_workflow",
    category: "tenant_write",
    input,
    output: {
      ok: false,
      denied: true,
      permission: "workflow:run",
      reason: grant.reason,
      error: grant.message,
      skipped_llm: true,
    },
    reply: `Permission denied: ${grant.message}.`,
    outcome: "denied",
  });
}

export async function runAndAnswer(
  p: FastPathParams,
  wf: RunTarget,
  input: Record<string, unknown>,
  grant: RunGrant,
  environment: ExecutionMode,
): Promise<FastPathHit> {
  const payload = await executeRunWorkflow(p, wf, grant, environment);
  return answerFastPath(p, {
    tool: "run_workflow",
    category: "tenant_write",
    input,
    output: { ok: payload.ok, ...payload.data, skipped_llm: true },
    reply: payload.reply,
    outcome: payload.outcome,
  });
}

export async function runPhase(p: FastPathParams, slugOrId: string): Promise<FastPathHit | null> {
  const gateSurface = gateSurfaceFor(p.surface);
  const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, slugOrId, {
    require_published: true,
  });
  if (!resolved?.current_version_id) return null;
  const wfView = await getWorkflow(p.tenant_id, resolved.id, p.db);
  if (wfView && resolveWorkflowInputContract(wfView.definition) !== null) {
    logger.info({
      module: "conversation",
      action: "fast_path.deferred_input_required",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      workflow_id: resolved.id,
    });
    return null;
  }
  const environment = await fastPathEnvironment(p, resolved, wfView?.connector_references ?? []);
  if (!environment) return null;
  const grant = await authorizeWorkflowRun(
    {
      principal: p.principal,
      workflow_id: resolved.id,
      workflow_slug: resolved.slug,
      via: "fast_path",
      tool: "run_workflow",
    },
    { db: p.db },
  );
  const runArgs = { workflow: resolved.slug, environment };
  if (grant.kind === "rejected") return denyRun(p, runArgs, grant);
  const gate = await runConfirmGate({
    tool: "run_workflow",
    category: "tenant_write",
    surface: gateSurface,
    args: runArgs,
    db: p.db,
    tenant_id: p.tenant_id,
    principal: p.principal,
    approval_tool: "run_workflow",
    via: "fast_path",
    record_surface: p.surface ?? "api",
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    execution_mode: environment,
    precheck: null,
    pause_blocked: false,
    confirmation_kind: null,
    environment,
  });
  if (gate.kind === "approval_failed") throw gate.error;
  if (gate.kind === "needs_confirm") {
    if (gate.approval_id === null) {
      throw new Error("fast path paused a run without an approval although its principal is known");
    }
    const confirm_id = gate.approval_id;
    const prepared = await prepareGate("run_workflow", runArgs, p.tenant_id, p.db);
    const envelope = confirmEnvelopeFor({
      tool: "run_workflow",
      pending_output: prepared.pending_output,
      rule: gate.rule,
      approval_id: confirm_id,
      approval_url: gate.approval_url,
      surface: gateSurface,
    });
    return answerFastPath(p, {
      tool: "run_workflow",
      category: "tenant_write",
      input: runArgs,
      output: {
        ok: false,
        pending: true,
        status: "awaiting_confirmation",
        policy_mode: "confirm_before_execution",
        confirm_required: true,
        pending_output: envelope.pending_output,
        resume: `A person must approve this by replying "yes" here — the engine replays the arguments it already holds. Nothing runs until they do; you cannot approve on their behalf.`,
        skipped_llm: true,
        suggested_command: `/workflows run ${resolved.slug}`,
      },
      reply: `Confirm: run ${resolved.slug} in ${environment}?`,
      outcome: "pending",
      status: "awaiting_input",
      confirmation_data: { approval_id: confirm_id },
    });
  }
  if (gate.kind !== "proceed") {
    throw new Error(`fast path cannot shape a ${gate.kind} confirm gate outcome`);
  }
  const hit = await runAndAnswer(p, resolved, runArgs, grant, environment);
  logger.info({
    module: "conversation",
    action: "conversation.fast_path",
    msg: "fast-path executed run_workflow",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    workflow_id: resolved.id,
    slug: resolved.slug,
  });
  return hit;
}
