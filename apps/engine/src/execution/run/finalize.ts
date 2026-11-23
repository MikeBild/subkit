import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { workflows } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { recordExecutionOutcome } from "../../self-healing/outcome-tracker.ts";
import { unregisterAbort } from "../abort.ts";
import { refusedConnectorOf } from "../connector-availability.ts";
import {
  executionAuditOutcome,
  heldWriteSteps,
  runResultError,
  sensitiveOutputSchemaCheck,
} from "../core/run.ts";
import { settledOutcome } from "../core/status.ts";
import { rollupConnectorResolutions } from "../engine/connector-rollup.ts";
import { maybeOffload } from "../offload.ts";
import { declaredSecretValues, resultMarkdown } from "../result-markdown.ts";
import {
  sensitiveFailure,
  sensitiveOutputShape,
  sensitiveRequestMeta,
} from "../sensitive-payload.ts";
import { settleTerminalOutcome } from "../settle-terminal.ts";
import { finalizeExecution } from "../state.ts";
import type { RunResult } from "../types.ts";
import type { OutputChecks } from "./checks.ts";
import type { RunEnv, RunState } from "./env.ts";

const SENSITIVE_WARNING_CODES: ReadonlySet<string> = new Set(["pagination_truncated"]);

function stepErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function stepErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

async function bumpLastExecutedAt(env: RunEnv): Promise<void> {
  const { db, tenant_id, execution_id } = env;
  const workflow_id = env.resolved.workflow_id;
  if (!env.resolved.persist_workflow_refs || !workflow_id) return;
  try {
    await db
      .update(workflows)
      .set({ last_executed_at: new Date(env.clock.now()) })
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "engine.last_executed_at_write_failed",
      msg: "failed to bump workflows.last_executed_at",
      tenant_id,
      workflow_id,
      execution_id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      getMetrics().inc(METRIC_NAMES.WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL, {
        tenant_id,
      });
    } catch {}
  }
}

function sensitiveRunResult(
  env: RunEnv,
  state: RunState,
  checks: OutputChecks,
  runResult: RunResult,
): RunResult {
  runResult.error = runResult.error
    ? sensitiveFailure(runResult.error.code, runResult.error.message)
    : null;
  runResult.steps = runResult.steps.map(({ held_request: _heldRequest, ...step }) => ({
    ...step,
    output_preview: null,
    raw_preview: null,
    request_meta: sensitiveRequestMeta(step.request_meta),
    error: step.error
      ? sensitiveFailure(stepErrorCode(step.error), stepErrorMessage(step.error))
      : null,
  }));
  const safeWarnings = state.warnings
    .filter((warning) => SENSITIVE_WARNING_CODES.has(warning.code))
    .map((warning) => ({
      code: warning.code,
      step_key: warning.step_key,
      message: sensitiveFailure(warning.code).message,
    }));
  if (safeWarnings.length > 0) runResult.warnings = safeWarnings;
  if (env.sensitiveMetadataPreview) {
    runResult.sensitive_checks = {
      validation: checks.validationVerdict,
      output_schema: sensitiveOutputSchemaCheck(
        Boolean(env.def.output_schema),
        checks.outputContract,
      ),
      output_shape: sensitiveOutputShape(state.lastOutput, env.def.output_schema),
    };
    runResult.output = null;
  }
  return runResult;
}

export async function finalizeRun(
  env: RunEnv,
  state: RunState,
  checks: OutputChecks,
): Promise<RunResult> {
  const { db, tenant_id, execution_id, execution_privacy, def } = env;
  const workflow_id = env.resolved.workflow_id;
  clearTimeout(env.totalTimer);
  const settled = settleTerminalOutcome({
    status: state.finalStatus,
    timed_out: env.totalTimeout.signal.aborted,
    aborted: env.abort.signal.aborted,
    output_contract: checks.outputContract,
    failure: state.validationError ?? state.lastError,
  });
  state.finalStatus = settled.status;
  const finalStatus = settled.status;
  const refusedConnector = settled.failure ? refusedConnectorOf(settled.failure) : null;

  const offload = await maybeOffload(db, {
    tenant_id,
    execution_id,
    step_id: null,
    result: state.lastOutput ?? null,
    execution_privacy,
  });

  await finalizeExecution(db, tenant_id, execution_id, settledOutcome(finalStatus), {
    result_storage_uri: offload.storage_uri,
    failure: settled.failure
      ? {
          step_id: state.failedStepId,
          error_code: settled.failure.code,
          error_message: settled.failure.message,
          ...(refusedConnector ? { connector: refusedConnector } : {}),
        }
      : null,
    result_sha256: offload.sha256,
    output_contract: settled.output_contract,
    ...(execution_privacy === "sensitive" ? { sensitive_result: state.lastOutput ?? null } : {}),
    ...(execution_privacy !== "sensitive" && finalStatus === "succeeded"
      ? {
          result_markdown: resultMarkdown(
            state.lastOutput,
            def.output_schema,
            declaredSecretValues(def.steps, state.scope),
          ),
        }
      : {}),
  });
  if (execution_privacy !== "sensitive" && env.opts.self_healing?.enabled !== false) {
    await recordExecutionOutcome(
      {
        tenant_id,
        workflow_id,
        outcome: finalStatus === "succeeded" ? "success" : "failure",
      },
      db,
    );
  }
  await bumpLastExecutedAt(env);
  const audit = executionAuditOutcome(finalStatus);
  await auditAwait(
    {
      tenant_id,
      ...env.callerActor,
      action:
        audit.kind === "aborted" ? AuditAction.EXECUTION_ABORTED : AuditAction.EXECUTION_COMPLETED,
      resource_type: "execution",
      resource_id: execution_id,
      result: audit.result,
      metadata: {
        final_status: finalStatus,
        workflow_id,
        total_llm_tokens: env.llmBudget.total,
        ...(def.max_llm_tokens_per_run !== undefined
          ? { max_llm_tokens_per_run: def.max_llm_tokens_per_run }
          : {}),
      },
    },
    db,
  );
  const held = heldWriteSteps(state.stepSummaries);
  if (held.length > 0) {
    await auditAwait(
      {
        tenant_id,
        ...env.callerActor,
        action: AuditAction.EXECUTION_WRITE_HELD,
        resource_type: "execution",
        resource_id: execution_id,
        result: "success",
        metadata: { workflow_id, held_steps: held },
      },
      db,
    );
  }

  unregisterAbort(execution_id);

  const runResult: RunResult = {
    execution_id,
    status: finalStatus,
    output: state.lastOutput,
    error: runResultError(state.validationError, state.lastError),
    steps: state.stepSummaries,
  };
  const resolutions = rollupConnectorResolutions(state.stepSummaries, env.execution_mode);
  if (execution_privacy === "sensitive") return sensitiveRunResult(env, state, checks, runResult);
  if (resolutions.length > 0) runResult.connector_resolutions = resolutions;
  if (state.warnings.length > 0) runResult.warnings = state.warnings;
  return runResult;
}
