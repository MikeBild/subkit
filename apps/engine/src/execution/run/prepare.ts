import { isDeepStrictEqual } from "node:util";
import { VERSION } from "@cli-core/version.ts";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { executions } from "../../db/schema/index.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { SANDBOX_TOOL_MANIFEST, STDLIB_VERSION } from "../../sandboxes/quickjs/stdlib/index.ts";
import { normalizeWorkflowRunInput } from "../../workflows/run-input.ts";
import { combineSignals, registerAbort, unregisterAbort } from "../abort.ts";
import { assertExecutionAuthorityCurrent } from "../authority-admission.ts";
import { authorizationContextFromPrincipal } from "../authorization-context.ts";
import { bindExistingRun } from "../bound-run.ts";
import { markBillableDispatch } from "../caller-budget.ts";
import { assertCallerMatches, callerFromPrincipal } from "../caller-context.ts";
import { resolveExecutionCallerActor, resolveExecutionCallerOrigin } from "../caller-origin.ts";
import { type Clock, type IdGen, SYSTEM_CLOCK, SYSTEM_IDS } from "../clock.ts";
import {
  allowsSensitiveMetadataPreview,
  defaultCallerOrigin,
  refusesSensitiveConversation,
  sensitiveRunUnsupported,
} from "../core/run.ts";
import { validateAgainstJsonSchema } from "../engine/envelope.ts";
import { capturePreparedWorkflowReferences } from "../prepared-workflow-references.ts";
import { type RunExecutionSource, resolveDefinition } from "../resolve-definition.ts";
import {
  createExecution,
  markExecutionRunning,
  markWriteDispatched,
  touchExecutionHeartbeat,
} from "../state.ts";
import { rateLimitNow } from "../steps/request/rate-limit.ts";
import { classifyRequestStepSideEffects } from "../steps/request/side-effects.ts";
import {
  MAX_CALL_DEPTH,
  RUN_HEARTBEAT_INTERVAL_MS,
  WORKFLOW_TIMEOUT_DEFAULT_MS,
} from "../timeouts.ts";
import { preparedApprovalClock } from "../tool-approval-dispatch.ts";
import type { RequestAuthoritySnapshot, RequestSource, RunOptions, RunResult } from "../types.ts";
import type { CallStepRunner, RunEnv } from "./env.ts";

export interface RunExecutionParams {
  db: Db;
  tenant_id: string;
  source: RunExecutionSource;
  input: unknown;
  options?: RunOptions;
  refusal_answered_to_caller?: boolean;
  on_started?: (execution_id: string) => void;
  heartbeat_interval_ms?: number;
  clock?: Clock;
  ids?: IdGen;
}

export type PreparedRun =
  | { kind: "not_started"; result: RunResult }
  | { kind: "ready"; env: RunEnv };

export async function prepareRun(
  p: RunExecutionParams,
  runCall: CallStepRunner,
): Promise<PreparedRun> {
  const { db, tenant_id } = p;
  const clock = p.clock ?? SYSTEM_CLOCK;
  const ids = p.ids ?? SYSTEM_IDS;
  const bound = await bindExistingRun(db, tenant_id, p.source, p.input, p.options ?? {});
  const opts = bound.options;
  const depth = opts.depth ?? 0;
  if (depth > MAX_CALL_DEPTH) {
    throw new Error(`call chain depth exceeded ${MAX_CALL_DEPTH}`);
  }

  const resolved = await resolveDefinition(db, tenant_id, bound.source);
  const def = resolved.def;
  const normalizedInput = normalizeWorkflowRunInput(bound.input, def.input_schema);
  const execution_privacy = opts.execution_privacy ?? def.execution_privacy;
  const workflow_id = resolved.workflow_id;
  const workflow_version_id = resolved.workflow_version_id;
  const caller =
    opts.caller_context !== undefined
      ? opts.caller_context
      : callerFromPrincipal(opts.principal, tenant_id, def.product_id, def.required_caller_kind);
  assertCallerMatches(caller, tenant_id, def.product_id, def.required_caller_kind);
  const sensitiveMetadataPreview = allowsSensitiveMetadataPreview(
    opts,
    execution_privacy,
    resolved.source_kind,
  );
  if (refusesSensitiveConversation(opts, execution_privacy, sensitiveMetadataPreview)) {
    throw Object.assign(new Error("Sensitive workflow output cannot enter conversation history."), {
      code: "sensitive_execution_unsupported",
    });
  }
  if (
    opts.principal &&
    !isDeepStrictEqual(
      caller,
      callerFromPrincipal(opts.principal, tenant_id, def.product_id, def.required_caller_kind),
    )
  ) {
    throw Object.assign(new Error("execution caller does not match the authenticated principal"), {
      code: "execution_boundary_mismatch",
    });
  }
  const caller_origin = resolveExecutionCallerOrigin(tenant_id, caller, defaultCallerOrigin(opts));
  const callerActor = resolveExecutionCallerActor(tenant_id, caller, caller_origin);
  if (execution_privacy === "sensitive" && sensitiveRunUnsupported(def.steps, opts)) {
    throw Object.assign(
      new Error(
        "Sensitive execution does not support persistent state, event waits or prepared fixture replay.",
      ),
      { code: "sensitive_execution_unsupported" },
    );
  }

  if (def.input_schema) {
    const check = validateAgainstJsonSchema(normalizedInput, def.input_schema, "$input");
    if (!check.valid) {
      throw Object.assign(
        new Error(
          execution_privacy === "sensitive"
            ? "Sensitive input validation failed."
            : check.errors.join("; "),
        ),
        {
          code: "input_schema_violation",
          details: execution_privacy === "sensitive" ? [] : check.errors,
        },
      );
    }
  }

  const request_source: RequestSource = opts.request_source ?? "api";
  const parent_execution_id = opts.parent_execution_id ?? null;
  const execution_mode = opts.execution_mode ?? "dev";
  const preparedReferences =
    resolved.source_kind === "saved" && (opts.hold_writes || opts.tool_approval_id)
      ? await capturePreparedWorkflowReferences(db, tenant_id, execution_mode, def)
      : undefined;
  if (
    preparedReferences &&
    opts.step_output_fixtures &&
    Object.keys(opts.step_output_fixtures).length
  ) {
    throw Object.assign(
      new Error("Prepared single-run decisions require fresh upstream reads, not cached fixtures."),
      { code: "prepared_fixture_unsupported" },
    );
  }

  const execution_started_at_date = new Date(clock.now());
  const preparedClock =
    opts.tool_approval_id && resolved.source_kind === "saved"
      ? await preparedApprovalClock(
          db,
          tenant_id,
          opts.tool_approval_id,
          resolved.workflow_id,
          resolved.workflow_version_id,
          execution_mode,
          normalizedInput,
        )
      : null;
  const evaluationInstant = preparedClock?.instant ?? execution_started_at_date;
  const execution_started_at = evaluationInstant.getTime();

  const execution_id = opts.existing_execution_id
    ? opts.existing_execution_id
    : await createExecution(db, {
        id: ids.uuid(),
        tenant_id,
        caller_context: caller,
        caller_origin,
        authorization_context: authorizationContextFromPrincipal(opts.principal),
        execution_privacy,
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        workflow_version_id: resolved.persist_workflow_refs ? workflow_version_id : null,
        source_kind: resolved.source_kind,
        source_ref: resolved.source_ref,
        hold_writes: opts.hold_writes ?? false,
        tool_approval_id: opts.tool_approval_id ?? null,
        request_source,
        parent_execution_id,
        ...(opts.authority_link ? { authority_link: opts.authority_link } : {}),
        execution_mode,
        input: normalizedInput ?? null,
        idempotency_key: opts.idempotency_key ?? null,
      });

  const evaluationSeed = preparedClock?.seed ?? execution_id;
  const ownConnectorCredentials =
    resolved.source_kind === "saved" && !opts.hold_writes
      ? await runsUnderExecutionAuthority(db, tenant_id, execution_id)
      : false;
  const billableSteps = new Set(def.execution_guards?.caller_daily_limit?.billable_steps ?? []);
  const beforeExternalRequest =
    (step_key: string) => async (snapshot: RequestAuthoritySnapshot) => {
      const policy = await assertExecutionAuthorityCurrent(db, tenant_id, execution_id, snapshot);
      if (snapshot.step_row_id && dispatchesWrite(def.steps, step_key, snapshot.request?.method))
        await markWriteDispatched(db, tenant_id, snapshot.step_row_id, new Date(clock.now()));
      if (billableSteps.has(step_key))
        await markBillableDispatch(db, {
          tenant_id,
          execution_id,
          step_key,
          ...(snapshot.step_row_id ? { step_row_id: snapshot.step_row_id } : {}),
        });
      return policy;
    };

  const ctrl = registerAbort(execution_id, tenant_id);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort("aborted");
    else
      opts.signal.addEventListener("abort", () => ctrl.abort("aborted"), {
        once: true,
      });
  }
  const totalTimeoutCtrl = new AbortController();
  const workflowTimeoutMs = def.timeout_ms ?? WORKFLOW_TIMEOUT_DEFAULT_MS;
  const workflowDeadlineMs = rateLimitNow() + workflowTimeoutMs;
  const totalTimer = setTimeout(
    () => totalTimeoutCtrl.abort("workflow_timeout"),
    workflowTimeoutMs,
  );
  const signal = combineSignals([ctrl.signal, totalTimeoutCtrl.signal]);

  const started =
    opts.crash_claimed === true ||
    (await markExecutionRunning(db, tenant_id, execution_id, execution_started_at_date));
  if (!started) {
    ctrl.abort("cancelled");
    clearTimeout(totalTimer);
    unregisterAbort(execution_id);
    return {
      kind: "not_started",
      result: {
        execution_id,
        status: "aborted",
        output: null,
        error: { code: "aborted", message: "execution aborted before start" },
        steps: [],
      },
    };
  }

  startHeartbeat(db, tenant_id, execution_id, p.heartbeat_interval_ms ?? RUN_HEARTBEAT_INTERVAL_MS);
  p.on_started?.(execution_id);

  await auditAwait(
    {
      tenant_id,
      ...callerActor,
      action: AuditAction.EXECUTION_STARTED,
      resource_type: "execution",
      resource_id: execution_id,
      result: "success",
      metadata: {
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        source_kind: resolved.source_kind,
        request_source,
        parent_execution_id,
        runtime: {
          engine: VERSION,
          stdlib: STDLIB_VERSION,
          tools: SANDBOX_TOOL_MANIFEST,
          clock_ms: evaluationInstant.getTime(),
          evaluation_seed: evaluationSeed,
        },
      },
    },
    db,
  );

  return {
    kind: "ready",
    env: {
      db,
      tenant_id,
      execution_id,
      def,
      resolved,
      opts,
      normalizedInput,
      caller,
      caller_origin,
      callerActor,
      execution_privacy,
      sensitiveMetadataPreview,
      request_source,
      parent_execution_id,
      execution_mode,
      depth,
      preparedReferences,
      evaluationInstant,
      execution_started_at,
      evaluationSeed,
      ownConnectorCredentials,
      beforeExternalRequest,
      llmBudget: new RunLlmBudget(def.max_llm_tokens_per_run ?? null),
      abort: ctrl,
      totalTimeout: totalTimeoutCtrl,
      totalTimer,
      signal,
      workflowDeadlineMs,
      clock,
      ids,
      runCall,
    },
  };
}

function dispatchesWrite(
  steps: RunEnv["def"]["steps"],
  step_key: string,
  method: string | undefined,
): boolean {
  const step = steps.find((candidate) => candidate.id === step_key);
  if (step?.kind !== "request") return false;
  try {
    return classifyRequestStepSideEffects(step, undefined, method) === "write";
  } catch {
    return true;
  }
}

function startHeartbeat(
  db: Db,
  tenant_id: string,
  execution_id: string,
  interval_ms: number,
): void {
  const timer = setInterval(() => {
    touchExecutionHeartbeat(db, tenant_id, execution_id, new Date())
      .then((running) => {
        if (!running) clearInterval(timer);
      })
      .catch(() => clearInterval(timer));
  }, interval_ms);
  timer.unref();
}

async function runsUnderExecutionAuthority(
  db: Db,
  tenant_id: string,
  execution_id: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      authority_id: executions.execution_authority_id,
      root_id: executions.authority_root_execution_id,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  return Boolean(row?.authority_id || row?.root_id);
}
