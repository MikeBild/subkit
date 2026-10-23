import { isDeepStrictEqual } from "node:util";
import { VERSION } from "@cli-core/version.ts";
import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { executions, workflowExecutionAuthorities, workflows } from "../db/schema/index.ts";
import { withTenantWork } from "../execution/tenant-work.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import { resolvePlaceholdersTypePreserving } from "../llm/substitution/resolver.ts";
import { withContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import {
  recordForEachExecution,
  recordLoopIterationsOffloaded,
} from "../observability/instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { withHostedWork } from "../queue/hosted-work.ts";
import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { SANDBOX_TOOL_MANIFEST, STDLIB_VERSION } from "../sandboxes/quickjs/stdlib/index.ts";
import { recordExecutionOutcome } from "../self-healing/outcome-tracker.ts";
import { buildStepDag, type StepDag, topoSort } from "../workflows/dag.ts";
import { WorkflowEffectManifestSchema } from "../workflows/effect-manifest.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import {
  type BranchStep,
  type CallStep,
  type LoopStep,
  type ParallelStep,
  type RequestStep,
  type StepDef,
  type WorkflowDef,
  WorkflowDefSchema,
} from "../workflows/types.ts";
import { combineSignals, registerAbort, unregisterAbort } from "./abort.ts";
import { assertExecutionAuthorityCurrent } from "./authority-admission.ts";
import { authorizationContextFromPrincipal } from "./authorization-context.ts";
import { bindExistingRun } from "./bound-run.ts";
import { markBillableDispatch } from "./caller-budget.ts";
import {
  assertCallerExecutionSource,
  assertCallerMatches,
  callerFromPrincipal,
} from "./caller-context.ts";
import { resolveExecutionCallerActor, resolveExecutionCallerOrigin } from "./caller-origin.ts";
import { connectorStepRefusal, refusedConnectorOf } from "./connector-availability.ts";
import { rollupConnectorResolutions } from "./engine/connector-rollup.ts";
import {
  bodyEnvelopeForLoopAccumulator,
  classifyBodyIteration,
  envelopeFor,
  validateAgainstJsonSchema,
  wrapEnvelope,
} from "./engine/envelope.ts";
import { evaluate as evaluateJsonata } from "./jsonata-engine.ts";
import { buildLoopChildScope, resolveForEachCollection } from "./loop-scope.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import { deepResolveOffloadRefs, previewOffloadRefs } from "./offload-rehydrate.ts";
import { checkOutputContract, summarizeViolations } from "./output-contract.ts";
import { capturePreparedWorkflowReferences } from "./prepared-workflow-references.ts";
import { type RunExecutionSource, resolveDefinition } from "./resolve-definition.ts";
import { applyResponseFilters } from "./response-filter.ts";
import {
  isSensitivePayload,
  sensitiveFailure,
  sensitiveOutputShape,
  sensitiveRequestMeta,
} from "./sensitive-payload.ts";
import { settleTerminalOutcome } from "./settle-terminal.ts";
import {
  createExecution,
  finalizeExecution,
  finalizeStepRow,
  insertStepRow,
  markExecutionRunning,
  type OutputContractVerdict,
} from "./state.ts";
import { type RunStepOutcome, runStep } from "./step-runner.ts";
import { rateLimitNow } from "./steps/request/rate-limit.ts";
import { classifyRequestStepSideEffects } from "./steps/request/side-effects.ts";
import { MAX_CALL_DEPTH, WORKFLOW_TIMEOUT_DEFAULT_MS } from "./timeouts.ts";
import { preparedApprovalClock } from "./tool-approval-dispatch.ts";
import {
  type ExecutionStatus,
  HELD_PREVIEW_WARNING_CODE,
  hasHeldOutput,
  type RequestSource,
  type RunOptions,
  type RunResult,
  type SensitiveCheckVerdict,
  type StepResult,
  type StepRunContext,
} from "./types.ts";

export { rollupConnectorResolutions } from "./engine/connector-rollup.ts";
export type { ScopeEnvelope } from "./engine/envelope.ts";

const DEFAULT_FOR_EACH_CONCURRENCY = 8;

export function resolveForEachConcurrency(
  step: StepDef,
  itemCount: number,
  baseUrl?: string | null,
): number {
  if (itemCount <= 1) return 1;
  const explicit = (step as { for_each_concurrency?: number }).for_each_concurrency;
  if (explicit != null && explicit >= 1) return Math.min(explicit, itemCount);
  if (
    step.kind === "request" &&
    classifyRequestStepSideEffects(step as RequestStep, undefined, undefined, baseUrl) === "read"
  ) {
    return Math.min(itemCount, DEFAULT_FOR_EACH_CONCURRENCY);
  }
  return 1;
}

function findHeldDependency(
  dag: StepDag,
  stepId: string,
  isMissing: (id: string) => boolean,
): string | null {
  for (const e of dag.edges) {
    if (e.from !== stepId) continue;
    if (e.to === stepId) continue;
    if (isMissing(e.to)) return e.to;
  }
  return null;
}

export interface RunExecutionParams {
  db: Db;
  tenant_id: string;
  source: RunExecutionSource;
  input: unknown;
  options?: RunOptions;
  refusal_answered_to_caller?: boolean;
}

export async function runExecution(p: RunExecutionParams): Promise<RunResult> {
  return withTenantWork(p.tenant_id, () =>
    withHostedWork(p.db, p.tenant_id, "execution", () => runExecutionAdmitted(p)),
  );
}

async function runExecutionAdmitted(p: RunExecutionParams): Promise<RunResult> {
  assertCallerExecutionSource(p.options?.principal, p.source.kind);
  const [persisted] = p.options?.existing_execution_id
    ? await p.db
        .select({ input: executions.input, workflow_version_id: executions.workflow_version_id })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, p.tenant_id),
            eq(executions.id, p.options.existing_execution_id),
          ),
        )
        .limit(1)
    : [];
  const privacySource =
    persisted?.workflow_version_id && p.source.kind === "saved"
      ? { ...p.source, version_id: persisted.workflow_version_id }
      : p.source;
  const resolved = await resolveDefinition(p.db, p.tenant_id, privacySource);
  const privacy =
    p.options?.execution_privacy ??
    resolved.def.execution_privacy ??
    (isSensitivePayload(persisted?.input) ? "sensitive" : undefined);
  return withContext(
    {
      execution_privacy: privacy,
      tenant_id: p.tenant_id,
      ...(p.options?.existing_execution_id
        ? { execution_id: p.options.existing_execution_id }
        : {}),
    },
    () => runProtectedExecution({ ...p, options: { ...p.options, execution_privacy: privacy } }),
  );
}

async function runProtectedExecution(p: RunExecutionParams): Promise<RunResult> {
  try {
    return await executeRun(p);
  } catch (error) {
    const execution_id = p.options?.existing_execution_id;
    const refusalCode = (error as { code?: unknown }).code;
    const unboundRefusal = [
      "execution_boundary_mismatch",
      "sensitive_resume_forbidden",
      "caller_required",
      "caller_tenant_mismatch",
      "caller_product_mismatch",
      "caller_kind_mismatch",
    ].includes(typeof refusalCode === "string" ? refusalCode : "");
    if (execution_id && !unboundRefusal) {
      const { code, details } = error as { code?: unknown; details?: unknown };
      const named =
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as { step_id?: unknown; connector_id?: unknown; reason?: unknown })
          : {};
      const connectorRefusal = code === "prepared_credential_unavailable";
      const refused = connectorRefusal && p.refusal_answered_to_caller === true;
      await finalizeExecution(
        p.db,
        p.tenant_id,
        execution_id,
        "failed",
        null,
        {
          step_id: typeof named.step_id === "string" ? named.step_id : null,
          error_code: typeof code === "string" ? code : "execution_error",
          error_message: error instanceof Error ? error.message : String(error),
          ...(connectorRefusal && typeof named.reason === "string"
            ? {
                connector: {
                  connector_id: typeof named.connector_id === "string" ? named.connector_id : null,
                  reason: named.reason,
                },
              }
            : {}),
        },
        ["queued"],
        null,
        "none",
        refused,
      ).catch(() => undefined);
    }
    if (p.options?.execution_privacy === "sensitive") {
      const code = (error as { code?: string }).code;
      throw Object.assign(new Error("Sensitive execution could not be resumed or run."), {
        code: [
          "sensitive_resume_forbidden",
          "sensitive_execution_unsupported",
          "execution_boundary_mismatch",
          "input_schema_violation",
        ].includes(code ?? "")
          ? code
          : "sensitive_execution_failure",
      });
    }
    throw error;
  }
}

async function executeRun(p: RunExecutionParams): Promise<RunResult> {
  const { db, tenant_id } = p;
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
  const sensitiveMetadataPreview =
    opts.sensitive_metadata_preview === true &&
    execution_privacy === "sensitive" &&
    resolved.source_kind === "draft" &&
    opts.hold_writes === true &&
    !opts.existing_execution_id &&
    !opts.tool_approval_id;
  if (
    (opts.sensitive_metadata_preview === true && !sensitiveMetadataPreview) ||
    (execution_privacy === "sensitive" &&
      opts.request_source === "chat" &&
      !sensitiveMetadataPreview)
  ) {
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
  const caller_origin = resolveExecutionCallerOrigin(
    tenant_id,
    caller,
    opts.caller_origin ?? (!opts.existing_execution_id && opts.principal ? "principal" : "unknown"),
  );
  const callerActor = resolveExecutionCallerActor(tenant_id, caller, caller_origin);
  if (execution_privacy === "sensitive") {
    const unsafe = def.steps.some(
      (step) =>
        step.kind === "wait_for_event" ||
        (step.kind === "request" && (step.state_write || step.state_read)),
    );
    if (unsafe || opts.tool_approval_id || opts.step_output_fixtures)
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

  const execution_started_at_date = new Date();
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
    (step_key: string) => async (snapshot: import("./types.ts").RequestAuthoritySnapshot) => {
      const policy = await assertExecutionAuthorityCurrent(db, tenant_id, execution_id, snapshot);
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

  const started = await markExecutionRunning(
    db,
    tenant_id,
    execution_id,
    execution_started_at_date,
  );
  if (!started) {
    ctrl.abort("cancelled");
    clearTimeout(totalTimer);
    unregisterAbort(execution_id);
    return {
      execution_id,
      status: "aborted",
      output: null,
      error: { code: "aborted", message: "execution aborted before start" },
      steps: [],
    };
  }

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

  const llmBudget = new RunLlmBudget(def.max_llm_tokens_per_run ?? null);

  const scope: Record<string, unknown> = { $input: normalizedInput, $caller: caller };

  let finalStatus: ExecutionStatus = "succeeded";
  const stepSummaries: RunResult["steps"] = [];
  let lastOutput: unknown = null;
  let lastError: { code: string; message: string } | null = null;
  let failedStepId: string | null = null;
  let validationError: {
    code: string;
    message: string;
    details?: unknown;
  } | null = null;
  const skippedStepIds = new Set<string>();
  const heldOrSkippedStepIds = new Set<string>();
  const skipUntakenArm = (branchStep: BranchStep, output: unknown): void => {
    const arm = (output as { arm?: string } | null | undefined)?.arm;
    const skip = arm === "then" ? (branchStep.else_steps ?? []) : (branchStep.then_steps ?? []);
    for (const skipId of skip) skippedStepIds.add(skipId);
  };
  const warningsAccum: NonNullable<RunResult["warnings"]> = [];

  const dag = buildStepDag(def);
  const stepIndexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  let executionOrder: ReadonlyArray<string>;
  try {
    executionOrder = topoSort(dag);
  } catch (err) {
    logger.error({
      module: "execution",
      action: "engine.topo_sort_fallback",
      msg: "topoSort failed at run time despite pre-flight cycle gate — falling back to declaration order",
      tenant_id,
      execution_id,
      workflow_name: def.name,
      step_count: def.steps.length,
      error: err instanceof Error ? err.message : String(err),
    });
    executionOrder = def.steps.map((s) => s.id);
  }

  const containerChildIds = new Set<string>();
  for (const s of def.steps) {
    if (s.kind === "parallel") {
      const p = s as ParallelStep;
      for (const branch of p.branches ?? []) {
        for (const id of branch ?? []) containerChildIds.add(id);
      }
    } else if (s.kind === "loop") {
      const l = s as LoopStep;
      for (const id of l.body ?? []) containerChildIds.add(id);
    }
  }

  for (let topoIdx = 0; topoIdx < executionOrder.length; topoIdx++) {
    const id = executionOrder[topoIdx]!;
    const i = stepIndexById.get(id) ?? topoIdx;
    const step = def.steps[i] as StepDef;
    if (signal.aborted) {
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: "aborted",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "aborted", message: "execution aborted" },
      });
      continue;
    }
    if (skippedStepIds.has(step.id) || containerChildIds.has(step.id)) {
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: "skipped",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "skipped", message: "skipped by branch control flow" },
      });
      continue;
    }
    const fixtureEnvelope = opts.step_output_fixtures?.[step.id];
    if (fixtureEnvelope !== undefined) {
      const envObj = fixtureEnvelope as Record<string, unknown>;
      const fixtureData = (envObj as { data?: unknown }).data;
      scope[step.id] = fixtureEnvelope;
      lastOutput = fixtureData;
      if (step.kind === "branch") skipUntakenArm(step as BranchStep, fixtureData);
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: "succeeded",
        duration_ms: 0,
        retry_count: 0,
        error: null,
        output_preview: fixtureData,
      });
      continue;
    }
    if (opts.hold_writes) {
      const heldDep = findHeldDependency(dag, step.id, (sid) => heldOrSkippedStepIds.has(sid));
      if (heldDep) {
        heldOrSkippedStepIds.add(step.id);
        stepSummaries.push({
          step_key: step.id,
          step_index: i,
          kind: step.kind,
          status: "skipped",
          duration_ms: 0,
          retry_count: 0,
          error: {
            code: "skipped_dependency_held",
            message: `skipped (depends on held step "${heldDep}")`,
          },
        });
        continue;
      }
    }
    const step_row_id = await insertStepRow(db, {
      tenant_id,
      execution_id,
      step_key: step.id,
      step_index: i,
      kind: step.kind,
    });
    const ctx: StepRunContext = {
      ...(preparedReferences ? { prepared_workflow_references: preparedReferences } : {}),
      before_external_request: beforeExternalRequest(step.id),
      db,
      tenant_id,
      execution_id,
      workflow_id,
      workflow_version_id,
      request_source,
      parent_execution_id,
      depth,
      signal,
      scope,
      started_at: evaluationInstant,
      evaluation_seed: evaluationSeed,
      workflow_slug: resolved.workflow_slug,
      trace_id: opts.trace_id ?? null,
      principal: opts.principal ?? null,
      caller_context: caller,
      caller_origin,
      execution_privacy,
      execution_mode,
      step,
      step_index: i,
      step_row_id,
      llm_budget: llmBudget,
      persist_workflow_refs: resolved.persist_workflow_refs,
      workflow_deadline_ms: workflowDeadlineMs,
      ...(ownConnectorCredentials ? { own_connector_credentials: true } : {}),
      ...(opts.hold_writes ? { hold_writes: true } : {}),
    };
    let childHeld = false;
    const recordHeldChild = (key: string, child: StepRunContext, result: RunStepOutcome) => {
      if (hasHeldOutput(result.result)) childHeld = true;
      for (const warning of result.result.warnings ?? []) {
        warningsAccum.push({ ...warning, step_key: key });
      }
      if (!result.result.held) return;
      childHeld = true;
      stepSummaries.push({
        step_key: key,
        step_index: i,
        kind: child.step.kind,
        status: result.result.status,
        duration_ms: result.result.duration_ms ?? null,
        retry_count: result.result.retry_count ?? 0,
        error: result.result.error ?? null,
        request_meta: result.result.request_meta ?? null,
        held: true,
        ...(result.result.held_request ? { held_request: result.result.held_request } : {}),
      });
    };

    if (step.for_each) {
      const forEachStart = Date.now();
      const collectionResult = await resolveForEachCollection(
        step.for_each,
        step.id,
        scope,
        forEachStart,
        {
          now_ms: ctx.started_at.getTime(),
          seed: `${evaluationSeed}:${step.id}`,
        },
        ctx.signal,
      );
      let fanOutCircuitFailure: StepResult | null = null;
      let fanOutBaseUrl: string | null = null;
      if (collectionResult.kind === "collection" && step.kind === "request" && step.connector_id) {
        const target = await getConnectorForEnvironment(
          tenant_id,
          step.connector_id,
          execution_mode,
          db,
        );
        fanOutBaseUrl = target?.base_url ?? null;
        const refusal = target ? connectorStepRefusal(target, step, execution_mode) : null;
        if (refusal) {
          fanOutCircuitFailure = {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - forEachStart,
            error: refusal,
          };
        } else if (target && isCircuitOpenBlocking(target)) {
          logger.warn({
            module: "execution",
            action: "for_each.circuit_open_preflight",
            msg: "for_each target connector circuit breaker is open — failing the container without scheduling iterations",
            tenant_id,
            execution_id,
            step_id: step.id,
            connector_id: target.id,
            connector_slug: target.slug,
            iterations_not_scheduled: collectionResult.items.length,
          });
          fanOutCircuitFailure = {
            status: "failed",
            retry_count: 0,
            duration_ms: Date.now() - forEachStart,
            error: {
              code: "circuit_open",
              message: `connector circuit breaker is open — ${collectionResult.items.length} for_each iteration(s) not scheduled`,
            },
          };
        }
      }
      if (collectionResult.kind === "failure" || fanOutCircuitFailure !== null) {
        const failedResult =
          fanOutCircuitFailure ?? (collectionResult as { result: StepResult }).result;
        const failureOutcome: import("./step-runner.ts").RunStepOutcome = {
          result: failedResult,
          scope_value: undefined,
        };
        scope[step.id] = envelopeFor(failureOutcome);
        lastOutput = undefined;
        await finalizeStepRow(
          db,
          step_row_id,
          failedResult.status as import("./types.ts").StepStatus,
          {
            status: failedResult.status,
            duration_ms: failedResult.duration_ms ?? 0,
            retry_count: failedResult.retry_count ?? 0,
            error: failedResult.error ?? null,
          },
          {
            tenant_id,
            output_preview: null,
            result_preview: null,
            result_storage_uri: null,
          },
        );
        stepSummaries.push({
          step_key: step.id,
          step_index: i,
          kind: step.kind,
          status: failedResult.status,
          duration_ms: failedResult.duration_ms ?? null,
          retry_count: failedResult.retry_count ?? 0,
          error: failedResult.error ?? null,
          request_meta: null,
        });
        if (failedResult.status !== "succeeded") {
          const onError = step.on_error ?? "fail";
          const stepError = failedResult.error ?? {
            code: "step_failed",
            message: "step failed",
          };
          if (onError === "fail") {
            lastError = stepError;
            failedStepId = step.id;
            finalStatus = "failed";
            for (let j = topoIdx + 1; j < executionOrder.length; j++) {
              const remainingId = executionOrder[j]!;
              const remainingIdx = stepIndexById.get(remainingId) ?? j;
              const s = def.steps[remainingIdx] as StepDef;
              stepSummaries.push({
                step_key: s.id,
                step_index: remainingIdx,
                kind: s.kind,
                status: "skipped",
                duration_ms: 0,
                retry_count: 0,
                error: {
                  code: "skipped",
                  message: "skipped due to upstream failure",
                },
                request_meta: null,
              });
            }
            break;
          }
          warningsAccum.push({
            code: "step_failed_continued",
            step_key: step.id,
            message: `step "${step.id}" ${failedResult.status} (${stepError.code}: ${stepError.message}) but declares on_error:"continue" — the run continued`,
            details: {
              step_status: failedResult.status,
              error_code: stepError.code,
            },
          });
        }
        continue;
      }
      if (collectionResult.kind === "empty_warning") {
        const warnResult = collectionResult.result;
        scope[step.id] = wrapEnvelope({
          data: [],
          duration_ms: warnResult.duration_ms ?? 0,
          error: null,
        });
        lastOutput = [];
        for (const w of warnResult.warnings ?? []) {
          warningsAccum.push({ ...w, step_key: step.id });
        }
        await finalizeStepRow(
          db,
          step_row_id,
          "succeeded",
          {
            status: "succeeded",
            duration_ms: warnResult.duration_ms ?? 0,
            retry_count: 0,
          },
          {
            tenant_id,
            output_preview: [],
            result_preview: null,
            result_storage_uri: null,
          },
        );
        stepSummaries.push({
          step_key: step.id,
          step_index: i,
          kind: step.kind,
          status: "succeeded",
          duration_ms: warnResult.duration_ms ?? null,
          retry_count: 0,
          error: null,
          request_meta: null,
          output_preview: [],
        });
        continue;
      }
      const items = collectionResult.items;
      const slots: (Record<string, unknown> | undefined)[] = new Array(items.length);
      let forEachFailure: import("./step-runner.ts").RunStepOutcome | null = null;

      const runIteration = async (itemIdx: number): Promise<void> => {
        const item = items[itemIdx];
        const childScope = buildLoopChildScope(scope, item, itemIdx);
        const iterStepRowId = await insertStepRow(db, {
          tenant_id,
          execution_id,
          step_key: `${step.id}[${itemIdx}]`,
          step_index: i,
          kind: step.kind,
        });
        if (opts.hold_writes) {
          const heldDep = findHeldDependency(dag, step.id, (sid) => heldOrSkippedStepIds.has(sid));
          if (heldDep) {
            const skippedEnv = wrapEnvelope({
              data: null,
              duration_ms: 0,
              error: {
                code: "skipped_dependency_held",
                message: `skipped (depends on held step "${heldDep}")`,
              },
            });
            slots[itemIdx] = { [step.id]: skippedEnv };
            return;
          }
        }
        const iterCtx: StepRunContext = {
          ...ctx,
          scope: childScope,
          evaluation_seed: `${ctx.evaluation_seed ?? execution_id}:for_each:${step.id}:${itemIdx}`,
          step_row_id: iterStepRowId,
        };
        const iterOutcome = await instrument({
          module: "execution",
          action: "step",
          level: "debug",
          thresholdMs: 1000,
          fields: {
            step_id: step.id,
            step_kind: step.kind,
            for_each_index: itemIdx,
          },
          fn: () =>
            runStep(
              iterCtx,
              childScope,
              normalizedInput,
              async ({ ctx: cctx, step: cstep, scope: cscope }) =>
                runCallStep(db, cctx, cstep as CallStep, cscope),
            ),
        });
        recordHeldChild(`${step.id}[${itemIdx}]`, iterCtx, iterOutcome);
        childScope[step.id] = envelopeFor(iterOutcome);
        slots[itemIdx] = {
          [step.id]: bodyEnvelopeForLoopAccumulator(iterOutcome),
        };
        if (
          forEachFailure === null &&
          (iterOutcome.result.status === "failed" ||
            iterOutcome.result.status === "aborted" ||
            iterOutcome.result.status === "timed_out")
        ) {
          forEachFailure = iterOutcome;
        }
      };

      const concurrency = resolveForEachConcurrency(step, items.length, fanOutBaseUrl);
      if (concurrency <= 1) {
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          if (signal.aborted) break;
          await runIteration(itemIdx);
        }
      } else {
        let cursor = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            if (signal.aborted) return;
            const myIdx = cursor++;
            if (myIdx >= items.length) return;
            await runIteration(myIdx);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
        );
      }
      const iterationResults: unknown[] = slots.filter((s) => s !== undefined);
      if (childHeld) heldOrSkippedStepIds.add(step.id);
      recordForEachExecution({
        tenant_id,
        step_kind: step.kind,
        items: items.length,
        concurrency,
        explicit: (step as { for_each_concurrency?: number }).for_each_concurrency != null,
        duration_ms: Date.now() - forEachStart,
      });
      scope[step.id] = wrapEnvelope({
        data: iterationResults,
        duration_ms: Date.now() - forEachStart,
        error: null,
      });
      lastOutput = iterationResults;
      if (iterationResults.length > 0) {
        let offloadedIterations = 0;
        const productiveIterations = iterationResults.filter((iter) => {
          const { productive, offloaded } = classifyBodyIteration(iter);
          if (offloaded) offloadedIterations += 1;
          return productive;
        }).length;
        if (offloadedIterations > 0) {
          recordLoopIterationsOffloaded({
            tenant_id,
            count: offloadedIterations,
          });
        }
        if (productiveIterations === 0) {
          warningsAccum.push({
            code: "loop_body_empty",
            identifier: step.id,
            message: `for_each step "${step.id}" ran ${iterationResults.length} iteration${iterationResults.length === 1 ? "" : "s"} but no iteration produced productive output — every result was null / [] / {}`,
            step_key: step.id,
            details: {
              iterations: iterationResults.length,
              productive_iterations: 0,
              scope_shape: `$scope.${step.id}.data is an array of ${iterationResults.length} iteration objects`,
            },
          });
        }
      }
      const forEachDurationMs = Date.now() - forEachStart;
      const failedOutcome = forEachFailure as import("./step-runner.ts").RunStepOutcome | null;
      const forEachStatus: "succeeded" | "failed" | "aborted" | "timed_out" = failedOutcome
        ? (failedOutcome.result.status as "failed" | "aborted" | "timed_out")
        : "succeeded";
      const forEachError = failedOutcome
        ? (failedOutcome.result.error ?? {
            code: "loop_body_failed",
            message: "loop body failed",
          })
        : null;
      await finalizeStepRow(
        db,
        step_row_id,
        forEachStatus,
        {
          status: forEachStatus,
          duration_ms: forEachDurationMs,
          retry_count: 0,
          ...(forEachError ? { error: forEachError } : {}),
        },
        {
          tenant_id,
          output_preview: previewOffloadRefs(iterationResults),
          result_preview: null,
          result_storage_uri: null,
        },
      );
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: forEachStatus,
        duration_ms: forEachDurationMs,
        retry_count: 0,
        error: forEachError,
        request_meta: null,
        output_preview: previewOffloadRefs(iterationResults),
      });
      if (forEachStatus !== "succeeded") {
        const onError = step.on_error ?? "fail";
        const stepError = forEachError ?? {
          code: "step_failed",
          message: "step failed",
        };
        if (onError === "fail") {
          lastError = stepError;
          failedStepId = step.id;
          if (forEachStatus === "aborted") finalStatus = "aborted";
          else if (forEachStatus === "timed_out") finalStatus = "timed_out";
          else finalStatus = "failed";
          for (let j = topoIdx + 1; j < executionOrder.length; j++) {
            const remainingId = executionOrder[j]!;
            const remainingIdx = stepIndexById.get(remainingId) ?? j;
            const s = def.steps[remainingIdx] as StepDef;
            stepSummaries.push({
              step_key: s.id,
              step_index: remainingIdx,
              kind: s.kind,
              status: "skipped",
              duration_ms: 0,
              retry_count: 0,
              error: {
                code: "skipped",
                message: "skipped due to upstream failure",
              },
              request_meta: null,
            });
          }
          break;
        }
        warningsAccum.push({
          code: "step_failed_continued",
          step_key: step.id,
          message: `step "${step.id}" ${forEachStatus} (${stepError.code}: ${stepError.message}) but declares on_error:"continue" — the run continued`,
          details: { step_status: forEachStatus, error_code: stepError.code },
        });
      }
      continue;
    }

    let outcome: import("./step-runner.ts").RunStepOutcome;
    try {
      outcome = await instrument({
        module: "execution",
        action: "step",
        level: "debug",
        thresholdMs: 1000,
        fields: { step_id: step.id, step_kind: step.kind },
        fn: () =>
          runStep(ctx, scope, normalizedInput, async ({ ctx: cctx, step: cstep, scope: cscope }) =>
            runCallStep(db, cctx, cstep as CallStep, cscope),
          ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        module: "execution",
        action: "execution.step_crash",
        msg: "step driver threw",
        execution_id,
        step_id: step.id,
        error: message,
      });
      outcome = {
        result: {
          status: "failed" as const,
          retry_count: 0,
          duration_ms: 0,
          error: { code: "step_crash", message },
        },
        scope_value: undefined,
      };
    }
    scope[step.id] = envelopeFor(outcome);
    lastOutput = outcome.scope_value;
    if (hasHeldOutput(outcome.result)) {
      heldOrSkippedStepIds.add(step.id);
    }
    if (outcome.result.warnings?.length) {
      for (const w of outcome.result.warnings) {
        warningsAccum.push({ ...w, step_key: step.id });
      }
    }

    if (step.kind === "branch" && outcome.result.status === "succeeded") {
      skipUntakenArm(step as BranchStep, outcome.result.output);
    }

    if (step.kind === "loop" && outcome.result.status === "succeeded") {
      const loopStep = step as LoopStep;
      const items = outcome.result.output;
      if (Array.isArray(items)) {
        const iterationResults: unknown[] = [];
        let loopBodyFailure: {
          step_id: string;
          result: import("./types.ts").StepResult;
        } | null = null;
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const childScope = buildLoopChildScope(scope, item, itemIdx);
          const bodyResults: Record<string, unknown> = {};
          const iterationHeldIds = new Set<string>();
          for (const bodyStepId of loopStep.body) {
            const bodyStep = def.steps.find((s) => s.id === bodyStepId) as StepDef | undefined;
            if (!bodyStep) continue;
            if (opts.hold_writes) {
              const heldDep = findHeldDependency(
                dag,
                bodyStep.id,
                (sid) => iterationHeldIds.has(sid) || heldOrSkippedStepIds.has(sid),
              );
              if (heldDep) {
                iterationHeldIds.add(bodyStep.id);
                const skippedEnv = wrapEnvelope({
                  data: null,
                  duration_ms: 0,
                  error: {
                    code: "skipped_dependency_held",
                    message: `skipped (depends on held step "${heldDep}")`,
                  },
                });
                childScope[bodyStep.id] = skippedEnv;
                bodyResults[bodyStep.id] = skippedEnv;
                continue;
              }
            }
            const bodyStepRowId = await insertStepRow(db, {
              tenant_id,
              execution_id,
              step_key: `${bodyStep.id}[${itemIdx}]`,
              step_index: i,
              kind: bodyStep.kind,
            });
            const bodyCtx: import("./types.ts").StepRunContext = {
              ...(preparedReferences ? { prepared_workflow_references: preparedReferences } : {}),
              before_external_request: beforeExternalRequest(bodyStep.id),
              db,
              tenant_id,
              execution_id,
              workflow_id,
              workflow_version_id,
              request_source,
              parent_execution_id,
              depth,
              signal,
              scope: childScope,
              started_at: evaluationInstant,
              evaluation_seed: `${evaluationSeed}:loop:${loopStep.id}:${itemIdx}`,
              workflow_slug: resolved.workflow_slug,
              trace_id: opts.trace_id ?? null,
              principal: opts.principal ?? null,
              caller_context: caller,
              caller_origin,
              execution_privacy,
              execution_mode,
              step: bodyStep,
              step_index: i,
              step_row_id: bodyStepRowId,
              llm_budget: llmBudget,
              persist_workflow_refs: resolved.persist_workflow_refs,
              workflow_deadline_ms: workflowDeadlineMs,
              ...(ownConnectorCredentials ? { own_connector_credentials: true } : {}),
              ...(opts.hold_writes ? { hold_writes: true } : {}),
            };
            const bodyOutcome = await instrument({
              module: "execution",
              action: "step",
              level: "debug",
              thresholdMs: 1000,
              fields: { step_id: bodyStep.id, step_kind: bodyStep.kind },
              fn: () =>
                runStep(
                  bodyCtx,
                  childScope,
                  normalizedInput,
                  async ({ ctx: cctx, step: cstep, scope: cscope }) =>
                    runCallStep(db, cctx, cstep as CallStep, cscope),
                ),
            });
            const bodyMeta = bodyOutcome.result.request_meta ?? null;
            if (bodyMeta && (bodyMeta.driver === "http" || bodyMeta.driver === "connectorless")) {
              logger.info({
                module: "execution",
                action: "loop.iteration",
                step_id: bodyStep.id,
                parent_step_id: loopStep.id,
                iteration: itemIdx,
                resolved_url: bodyMeta.url,
                upstream_status: bodyMeta.status ?? null,
                outcome: bodyOutcome.result.status,
              });
            }
            childScope[bodyStep.id] = envelopeFor(bodyOutcome);
            recordHeldChild(`${bodyStep.id}[${itemIdx}]`, bodyCtx, bodyOutcome);
            bodyResults[bodyStep.id] = bodyEnvelopeForLoopAccumulator(bodyOutcome);
            if (hasHeldOutput(bodyOutcome.result)) {
              iterationHeldIds.add(bodyStep.id);
            }
            const bodyFailed =
              bodyOutcome.result.status === "failed" ||
              bodyOutcome.result.status === "aborted" ||
              bodyOutcome.result.status === "timed_out";
            if (bodyFailed && (bodyStep.on_error ?? "fail") === "fail") {
              if (loopBodyFailure === null) {
                loopBodyFailure = {
                  step_id: bodyStep.id,
                  result: bodyOutcome.result,
                };
              }
              if (loopStep.fail_fast === true) break;
            } else if (bodyFailed) {
              const bodyError = bodyOutcome.result.error ?? {
                code: "step_failed",
                message: "step failed",
              };
              if (
                !warningsAccum.some(
                  (w) => w.code === "step_failed_continued" && w.step_key === bodyStep.id,
                )
              ) {
                warningsAccum.push({
                  code: "step_failed_continued",
                  step_key: bodyStep.id,
                  message: `step "${bodyStep.id}" ${bodyOutcome.result.status} (${bodyError.code}: ${bodyError.message}) but declares on_error:"continue" — the run continued`,
                  details: {
                    step_status: bodyOutcome.result.status,
                    error_code: bodyError.code,
                  },
                });
              }
            }
          }
          iterationResults.push(bodyResults);
          if (loopStep.fail_fast === true && loopBodyFailure !== null) break;
        }
        scope[step.id] = wrapEnvelope({
          data: iterationResults,
          duration_ms: outcome.result.duration_ms ?? 0,
          error: null,
        });
        if (childHeld) heldOrSkippedStepIds.add(step.id);
        lastOutput = iterationResults;
        if (iterationResults.length > 0) {
          let offloadedIterations = 0;
          const productiveIterations = iterationResults.filter((iter) => {
            const { productive, offloaded } = classifyBodyIteration(iter);
            if (offloaded) offloadedIterations += 1;
            return productive;
          }).length;
          if (offloadedIterations > 0) {
            recordLoopIterationsOffloaded({
              tenant_id,
              count: offloadedIterations,
            });
          }
          if (productiveIterations === 0) {
            const sampleIteration = iterationResults[0];
            const bodyKeys =
              sampleIteration && typeof sampleIteration === "object"
                ? Object.keys(sampleIteration as Record<string, unknown>)
                : [];
            warningsAccum.push({
              code: "loop_body_empty",
              identifier: step.id,
              message: `loop "${step.id}" ran ${iterationResults.length} iteration${iterationResults.length === 1 ? "" : "s"} but no iteration produced productive body output — the body steps ran without errors but every result was null / [] / {}`,
              step_key: step.id,
              details: {
                iterations: iterationResults.length,
                productive_iterations: 0,
                body_step_ids: bodyKeys,
                scope_shape: `$scope.${step.id}.data is an array of ${iterationResults.length} iteration objects, each shaped { ${bodyKeys.map((k) => `${k}: { data, error, duration_ms }`).join(", ")} }`,
                example_path:
                  bodyKeys.length > 0
                    ? `$scope.${step.id}.data[0].${bodyKeys[0]}.data`
                    : `$scope.${step.id}.data`,
              },
            });
          }
        }
        if (loopBodyFailure) {
          outcome = {
            ...outcome,
            result: {
              ...outcome.result,
              status: loopBodyFailure.result.status,
              error: loopBodyFailure.result.error ?? {
                code: "loop_body_failed",
                message: `loop body step "${loopBodyFailure.step_id}" failed`,
              },
            },
          };
        }
      }
    }

    if (step.kind === "parallel" && outcome.result.status === "succeeded") {
      const parallelStep = step as ParallelStep;
      let branchFailure: RunStepOutcome | null = null;
      const branchResults = await instrument({
        module: "execution",
        action: "parallel",
        memory: true,
        fields: {
          step_id: step.id,
          branch_count: parallelStep.branches.length,
        },
        fn: () =>
          Promise.all(
            parallelStep.branches.map(async (branchStepIds, branchIndex) => {
              const branchScope: Record<string, unknown> = { ...scope };
              const branchOutput: Record<string, unknown> = {};
              const branchHeldIds = new Set<string>();
              for (const branchStepId of branchStepIds) {
                const branchStepDef = def.steps.find((s) => s.id === branchStepId) as
                  | StepDef
                  | undefined;
                if (!branchStepDef) continue;
                if (opts.hold_writes) {
                  const heldDep = findHeldDependency(
                    dag,
                    branchStepDef.id,
                    (sid) => branchHeldIds.has(sid) || heldOrSkippedStepIds.has(sid),
                  );
                  if (heldDep) {
                    branchHeldIds.add(branchStepDef.id);
                    const skippedEnv = wrapEnvelope({
                      data: null,
                      duration_ms: 0,
                      error: {
                        code: "skipped_dependency_held",
                        message: `skipped (depends on held step "${heldDep}")`,
                      },
                    });
                    branchScope[branchStepId] = skippedEnv;
                    branchOutput[branchStepId] = skippedEnv;
                    continue;
                  }
                }
                const branchStepRowId = await insertStepRow(db, {
                  tenant_id,
                  execution_id,
                  step_key: branchStepId,
                  step_index: i,
                  kind: branchStepDef.kind,
                });
                const branchCtx: import("./types.ts").StepRunContext = {
                  ...(preparedReferences
                    ? { prepared_workflow_references: preparedReferences }
                    : {}),
                  before_external_request: beforeExternalRequest(branchStepDef.id),
                  db,
                  tenant_id,
                  execution_id,
                  workflow_id,
                  workflow_version_id,
                  request_source,
                  parent_execution_id,
                  depth,
                  signal,
                  scope: branchScope,
                  started_at: evaluationInstant,
                  evaluation_seed: `${evaluationSeed}:parallel:${parallelStep.id}:${branchIndex}`,
                  workflow_slug: resolved.workflow_slug,
                  trace_id: opts.trace_id ?? null,
                  principal: opts.principal ?? null,
                  caller_context: caller,
                  caller_origin,
                  execution_privacy,
                  execution_mode,
                  step: branchStepDef,
                  step_index: i,
                  step_row_id: branchStepRowId,
                  llm_budget: llmBudget,
                  persist_workflow_refs: resolved.persist_workflow_refs,
                  workflow_deadline_ms: workflowDeadlineMs,
                  ...(ownConnectorCredentials ? { own_connector_credentials: true } : {}),
                  ...(opts.hold_writes ? { hold_writes: true } : {}),
                };
                const branchOutcome = await instrument({
                  module: "execution",
                  action: "step",
                  level: "debug",
                  thresholdMs: 1000,
                  fields: {
                    step_id: branchStepDef.id,
                    step_kind: branchStepDef.kind,
                  },
                  fn: () =>
                    runStep(
                      branchCtx,
                      branchScope,
                      normalizedInput,
                      async ({ ctx: cctx, step: cstep, scope: cscope }) =>
                        runCallStep(db, cctx, cstep as CallStep, cscope),
                    ),
                });
                branchScope[branchStepId] = envelopeFor(branchOutcome);
                recordHeldChild(branchStepId, branchCtx, branchOutcome);
                branchOutput[branchStepId] = envelopeFor(branchOutcome);
                if (hasHeldOutput(branchOutcome.result)) {
                  branchHeldIds.add(branchStepId);
                }
                if (
                  branchOutcome.result.status !== "succeeded" &&
                  (branchStepDef.on_error ?? "fail") === "fail"
                ) {
                  branchFailure ??= branchOutcome;
                  break;
                }
              }
              return branchOutput;
            }),
          ),
      });
      scope[step.id] = wrapEnvelope({
        data: branchResults,
        duration_ms: outcome.result.duration_ms ?? 0,
        error: null,
      });
      lastOutput = branchResults;
      if (childHeld) heldOrSkippedStepIds.add(step.id);
      const failure = branchFailure as RunStepOutcome | null;
      if (failure)
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            status: failure.result.status,
            error: failure.result.error ?? {
              code: "parallel_branch_failed",
              message: "a parallel branch failed",
            },
          },
        };
    }

    let outputPreview: unknown = outcome.result.output;
    if (step.kind === "loop" || step.kind === "parallel") {
      const wrapped = scope[step.id] as { data?: unknown } | undefined;
      if (wrapped && typeof wrapped === "object" && "data" in wrapped) {
        outputPreview = previewOffloadRefs(wrapped.data);
      }
    }
    stepSummaries.push({
      step_key: step.id,
      step_index: i,
      kind: step.kind,
      status: outcome.result.status,
      duration_ms: outcome.result.duration_ms ?? null,
      retry_count: outcome.result.retry_count ?? 0,
      error: outcome.result.error ?? null,
      request_meta: outcome.result.request_meta ?? null,
      ...(outcome.result.held
        ? {
            held: true as const,
            ...(outcome.result.held_request ? { held_request: outcome.result.held_request } : {}),
          }
        : {}),
      ...(outputPreview !== undefined ? { output_preview: outputPreview } : {}),
      ...(outcome.raw_output !== undefined ? { raw_preview: outcome.raw_output } : {}),
    });
    if (outcome.result.status !== "succeeded") {
      const onError = step.on_error ?? "fail";
      const stepError = outcome.result.error ?? {
        code: "step_failed",
        message: "step failed",
      };
      if (onError === "fail") {
        lastError = stepError;
        failedStepId = step.id;
        if (outcome.result.status === "aborted") finalStatus = "aborted";
        else if (outcome.result.status === "timed_out") finalStatus = "timed_out";
        else finalStatus = "failed";
        for (let j = topoIdx + 1; j < executionOrder.length; j++) {
          const remainingId = executionOrder[j]!;
          const remainingIdx = stepIndexById.get(remainingId) ?? j;
          const s = def.steps[remainingIdx] as StepDef;
          stepSummaries.push({
            step_key: s.id,
            step_index: remainingIdx,
            kind: s.kind,
            status: "skipped",
            duration_ms: 0,
            retry_count: 0,
            error: {
              code: "skipped",
              message: "skipped due to upstream failure",
            },
            request_meta: null,
          });
        }
        break;
      }
      warningsAccum.push({
        code: "step_failed_continued",
        step_key: step.id,
        message: `step "${step.id}" ${outcome.result.status} (${stepError.code}: ${stepError.message}) but declares on_error:"continue" — the run continued`,
        details: {
          step_status: outcome.result.status,
          error_code: stepError.code,
        },
      });
    }
  }

  if (lastOutput !== undefined && lastOutput !== null) {
    try {
      lastOutput = await deepResolveOffloadRefs(db, tenant_id, lastOutput, signal);
    } catch (err) {
      logger.warn({
        module: "execution",
        action: "execution.offload_resolution_failed",
        msg: "final-output offload re-hydration failed",
        execution_id,
        error: err instanceof Error ? err.message : String(err),
      });
      finalStatus = "failed";
      validationError = {
        code: "offload_resolution_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (lastOutput !== undefined && finalStatus === "succeeded") {
    if (def.output_transform) {
      try {
        const transformed = await evaluateJsonata(def.output_transform, lastOutput, {
          input: normalizedInput,
          scope,
          clock: { now_ms: execution_started_at, seed: `${evaluationSeed}:output_transform` },
        });
        if (transformed !== undefined) lastOutput = transformed;
      } catch (err) {
        logger.warn({
          module: "execution",
          action: "execution.output_transform_threw",
          msg: "output_transform threw",
          execution_id,
          error: err instanceof Error ? err.message : String(err),
        });
        finalStatus = "failed";
        validationError = {
          code: "output_transform_failed",
          message: `output_transform threw: ${err instanceof Error ? err.message : String(err)}`,
          details: { expression: def.output_transform },
        };
      }
    } else if (def.output_transform_function) {
      try {
        const result = await runJs<unknown>({
          code: def.output_transform_function,
          input: lastOutput,
          clock: {
            now_ms: execution_started_at,
            seed: `${evaluationSeed}:output_transform`,
          },
        });
        if (result.output !== undefined) lastOutput = result.output;
      } catch (err) {
        logger.warn({
          module: "execution",
          action: "execution.output_transform_function_threw",
          msg: "output_transform_function threw",
          execution_id,
          error: err instanceof Error ? err.message : String(err),
        });
        finalStatus = "failed";
        validationError = {
          code: "output_transform_failed",
          message: `output_transform_function threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          details: { expression: def.output_transform_function },
        };
      }
    }
  }

  if (
    def.response_filters &&
    def.response_filters.length > 0 &&
    lastOutput !== undefined &&
    finalStatus === "succeeded"
  ) {
    try {
      lastOutput = applyResponseFilters(def.response_filters, lastOutput);
    } catch (err) {
      logger.warn({
        module: "execution",
        action: "execution.response_filter_failed",
        msg: "workflow-level response_filter raised — probably a FAIL filter matched",
        execution_id,
        error: err instanceof Error ? err.message : String(err),
      });
      finalStatus = "failed";
      validationError = {
        code: "response_filter_failed",
        message: `workflow-level response filter failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const outputUnavailableDueToHolds = opts.hold_writes === true && heldOrSkippedStepIds.size > 0;
  if (def.output_schema && outputUnavailableDueToHolds && finalStatus === "succeeded") {
    logger.info({
      module: "execution",
      action: "execution.output_contract_skipped_held_preview",
      msg: "output_schema check skipped — hold-writes preview held the output-producing chain",
      execution_id,
      held_or_skipped: heldOrSkippedStepIds.size,
    });
  }
  if (outputUnavailableDueToHolds && finalStatus === "succeeded") {
    const heldWriteSteps = stepSummaries.filter((s) => s.held === true);
    const skippedDepSteps = stepSummaries.filter(
      (s) =>
        s.status === "skipped" &&
        (s.error as { code?: string } | null)?.code === "skipped_dependency_held",
    );
    warningsAccum.push({
      code: HELD_PREVIEW_WARNING_CODE,
      message:
        (heldWriteSteps.length > 0
          ? `Preview run (hold_writes): ${heldWriteSteps.length} write step(s) held`
          : "Preview run (hold_writes): writes held in called workflows") +
        `${skippedDepSteps.length > 0 ? ` and ${skippedDepSteps.length} dependent step(s) skipped` : ""}` +
        ` — NOTHING was written to any external system. The returned output is from upstream` +
        ` read/transform steps only.`,
      step_key: "$holds",
      details: {
        held_steps: heldWriteSteps.map((s) => s.step_key),
        skipped_steps: skippedDepSteps.map((s) => s.step_key),
        would_write: heldWriteSteps.map((s) => ({
          step: s.step_key,
          method: s.held_request?.method ?? null,
          url: s.held_request?.url ?? null,
        })),
      },
    });
  }
  let outputContract: OutputContractVerdict = "none";
  let validationVerdict: SensitiveCheckVerdict =
    def.validation_expression || def.validation_function ? "not_run" : "not_defined";
  if (
    def.output_schema &&
    lastOutput !== undefined &&
    finalStatus === "succeeded" &&
    !outputUnavailableDueToHolds
  ) {
    const contract = checkOutputContract(lastOutput, def.output_schema);
    if (contract.ok) outputContract = contract.valid ? "passed" : "violated";
    if (!contract.ok) {
      logger.warn({
        module: "execution",
        action: "execution.output_schema_invalid",
        msg: "output_schema did not compile; contract check skipped",
        execution_id,
        error: contract.schema_error,
      });
    } else if (!contract.valid) {
      logger.warn({
        module: "execution",
        action: "execution.output_contract_violation",
        msg: "final output does not satisfy output_schema",
        execution_id,
        violations: contract.violations,
      });
      warningsAccum.push({
        code: "output_contract_violation",
        message: `final output does not satisfy the workflow's output_schema (${contract.violations.length} violation(s)): ${summarizeViolations(contract.violations)}`,
        step_key: "$output",
        details: { violations: contract.violations },
      });
    }
  }

  if (def.validation_expression && lastOutput !== undefined && finalStatus === "succeeded") {
    try {
      const verdict = await evaluateJsonata(def.validation_expression, lastOutput, {
        input: normalizedInput,
        scope,
        clock: { now_ms: execution_started_at, seed: `${evaluationSeed}:validation` },
      });
      validationVerdict = verdict ? "passed" : "failed";
      if (!verdict) {
        logger.warn({
          module: "execution",
          action: "execution.validation_failed",
          msg: "validation_expression returned falsy",
          execution_id,
          expression: def.validation_expression,
        });
        finalStatus = "failed";
        validationError = {
          code: "validation_failed",
          message: `validation_expression \`${def.validation_expression}\` returned ${
            verdict === undefined ? "undefined" : JSON.stringify(verdict)
          }`,
          details: {
            expression: def.validation_expression,
            actual_value: lastOutput,
          },
        };
      }
    } catch (err) {
      validationVerdict = "failed";
      logger.warn({
        module: "execution",
        action: "execution.validation_threw",
        msg: "validation_expression threw",
        execution_id,
        error: err instanceof Error ? err.message : String(err),
      });
      finalStatus = "failed";
      validationError = {
        code: "validation_failed",
        message: `validation_expression \`${def.validation_expression}\` threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
        details: {
          expression: def.validation_expression,
          actual_value: lastOutput,
        },
      };
    }
  }

  if (def.validation_function && lastOutput !== undefined && finalStatus === "succeeded") {
    try {
      const result = await runJs<unknown>({
        code: def.validation_function,
        input: lastOutput,
        clock: {
          now_ms: execution_started_at,
          seed: `${evaluationSeed}:validation`,
        },
      });
      const verdict = result.output;
      validationVerdict = verdict === false ? "failed" : "passed";
      if (verdict === false) {
        logger.warn({
          module: "execution",
          action: "execution.validation_function_failed",
          msg: "validation_function returned false",
          execution_id,
        });
        finalStatus = "failed";
        validationError = {
          code: "validation_failed",
          message: "validation_function returned false",
          details: {
            expression: def.validation_function,
            actual_value: lastOutput,
          },
        };
      }
    } catch (err) {
      validationVerdict = "failed";
      logger.warn({
        module: "execution",
        action: "execution.validation_function_threw",
        msg: "validation_function threw",
        execution_id,
        error: err instanceof Error ? err.message : String(err),
      });
      finalStatus = "failed";
      validationError = {
        code: "validation_failed",
        message: `validation_function threw: ${err instanceof Error ? err.message : String(err)}`,
        details: {
          expression: def.validation_function,
          actual_value: lastOutput,
        },
      };
    }
  }

  clearTimeout(totalTimer);
  const settled = settleTerminalOutcome({
    status: finalStatus,
    timed_out: totalTimeoutCtrl.signal.aborted,
    aborted: ctrl.signal.aborted,
    output_contract: outputContract,
    failure: validationError ?? lastError,
  });
  finalStatus = settled.status;
  const refusedConnector = settled.failure ? refusedConnectorOf(settled.failure) : null;

  const offload = await maybeOffload(db, {
    tenant_id,
    execution_id,
    step_id: null,
    result: lastOutput ?? null,
    execution_privacy,
  });
  void previewOf;

  await finalizeExecution(
    db,
    tenant_id,
    execution_id,
    finalStatus,
    offload.storage_uri,
    settled.failure
      ? {
          step_id: failedStepId,
          error_code: settled.failure.code,
          error_message: settled.failure.message,
          ...(refusedConnector ? { connector: refusedConnector } : {}),
        }
      : null,
    undefined,
    offload.sha256,
    settled.output_contract,
    false,
    execution_privacy === "sensitive" ? (lastOutput ?? null) : undefined,
  );
  if (execution_privacy !== "sensitive" && opts.self_healing?.enabled !== false) {
    await recordExecutionOutcome(
      {
        tenant_id,
        workflow_id,
        outcome: finalStatus === "succeeded" ? "success" : "failure",
      },
      db,
    );
  }
  if (resolved.persist_workflow_refs && workflow_id) {
    try {
      await db
        .update(workflows)
        .set({ last_executed_at: new Date() })
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
  await auditAwait(
    {
      tenant_id,
      ...callerActor,
      action:
        finalStatus === "succeeded"
          ? AuditAction.EXECUTION_COMPLETED
          : finalStatus === "aborted"
            ? AuditAction.EXECUTION_ABORTED
            : AuditAction.EXECUTION_COMPLETED,
      resource_type: "execution",
      resource_id: execution_id,
      result: finalStatus === "succeeded" ? "success" : "error",
      metadata: {
        final_status: finalStatus,
        workflow_id,
        total_llm_tokens: llmBudget.total,
        ...(def.max_llm_tokens_per_run !== undefined
          ? { max_llm_tokens_per_run: def.max_llm_tokens_per_run }
          : {}),
      },
    },
    db,
  );

  unregisterAbort(execution_id);

  const runResult: RunResult = {
    execution_id,
    status: finalStatus,
    output: lastOutput,
    error: validationError
      ? { code: validationError.code, message: validationError.message }
      : lastError,
    steps: stepSummaries,
  };
  const resolutions = rollupConnectorResolutions(stepSummaries, execution_mode);
  if (execution_privacy === "sensitive") {
    runResult.error = runResult.error ? sensitiveFailure(runResult.error.code) : null;
    runResult.steps = runResult.steps.map(({ held_request: _heldRequest, ...step }) => ({
      ...step,
      output_preview: null,
      raw_preview: null,
      request_meta: sensitiveRequestMeta(step.request_meta),
      error: step.error ? sensitiveFailure(stepErrorCode(step.error)) : null,
    }));
    const safeWarnings = warningsAccum
      .filter((warning) => SENSITIVE_WARNING_CODES.has(warning.code))
      .map((warning) => ({
        code: warning.code,
        step_key: warning.step_key,
        message: sensitiveFailure(warning.code).message,
      }));
    if (safeWarnings.length > 0) runResult.warnings = safeWarnings;
    if (sensitiveMetadataPreview) {
      runResult.sensitive_checks = {
        validation: validationVerdict,
        output_schema: !def.output_schema
          ? "not_defined"
          : outputContract === "passed"
            ? "passed"
            : outputContract === "violated"
              ? "failed"
              : "not_run",
        output_shape: sensitiveOutputShape(lastOutput, def.output_schema),
      };
      runResult.output = null;
    }
    return runResult;
  }
  if (resolutions.length > 0) runResult.connector_resolutions = resolutions;
  if (warningsAccum.length > 0) runResult.warnings = warningsAccum;
  return runResult;
}

const SENSITIVE_WARNING_CODES: ReadonlySet<string> = new Set(["pagination_truncated"]);

function stepErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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

function collectCredentialTokens(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const tok of parsePlaceholders(v).tokens) {
        if (tok.kind === "cred") found.push(tok.raw);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(value);
  return [...new Set(found)];
}

async function runCallStep(
  db: Db,
  ctx: StepRunContext,
  step: CallStep,
  scope: Record<string, unknown>,
): Promise<StepResult> {
  const start = Date.now();
  const [parent] = await db
    .select({
      approval: executions.tool_approval_id,
      authority_id: executions.execution_authority_id,
      linked_root: executions.authority_root_execution_id,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.id, ctx.execution_id)))
    .limit(1);
  if (parent?.approval) {
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        ...resolveExecutionCallerActor(ctx.tenant_id, ctx.caller_context, ctx.caller_origin),
        action: AuditAction.APPROVAL_DISPATCH_DENIED,
        resource_type: "execution",
        resource_id: ctx.execution_id,
        result: "denied",
        reason: "prepared_call_unsupported",
        metadata: {
          approval_id: parent.approval,
          step_id: step.id,
          request_source: ctx.request_source,
        },
      },
      db,
    );
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "prepared_call_unsupported",
        message:
          "A prepared parent approval does not authorize a child workflow. Review the child boundary separately.",
      },
    };
  }
  if (ctx.depth + 1 > MAX_CALL_DEPTH) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "call_depth_exceeded",
        message: `max call depth ${MAX_CALL_DEPTH}`,
      },
    };
  }
  let targetId: string | undefined = step.workflow_id;
  if (!targetId && step.workflow_slug) {
    const rows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, step.workflow_slug),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    targetId = rows[0]?.id;
  }
  if (!targetId) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "call_target_missing", message: "workflow not found" },
    };
  }
  let authorityLink: { root_execution_id: string; call_path: string[] } | null = null;
  let pinnedChildVersion: string | null = null;
  if (parent?.linked_root) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "call_outside_approved_boundary",
        message:
          "A workflow started by an approved run may not start another one. Nothing was started.",
      },
    };
  }
  if (parent?.authority_id) {
    const [authority] = await db
      .select({ manifest: workflowExecutionAuthorities.effect_manifest })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, ctx.tenant_id),
          eq(workflowExecutionAuthorities.id, parent.authority_id),
        ),
      )
      .limit(1);
    const manifest = WorkflowEffectManifestSchema.safeParse(authority?.manifest);
    const pin = manifest.success
      ? manifest.data.calls?.find((candidate) => candidate.step_id === step.id)
      : undefined;
    if (!pin || pin.workflow_id !== targetId) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "call_outside_approved_boundary",
          message:
            "This run is approved for repeated runs, and the approval does not cover starting this workflow here. Nothing was started. Review and approve this workflow again.",
        },
      };
    }
    const [child] = await db
      .select({ lifecycle: workflows.lifecycle, current: workflows.current_version_id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, targetId),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    if (child?.lifecycle !== "active" || child.current !== pin.workflow_version_id) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "call_child_version_changed",
          message:
            "The workflow this step starts now has a different active version than the one approved. Nothing was started. Review and approve this workflow again.",
        },
      };
    }
    pinnedChildVersion = pin.workflow_version_id;
    authorityLink = { root_execution_id: ctx.execution_id, call_path: [step.id] };
  }
  let resolvedInput: unknown = step.input;
  if (step.input !== undefined && step.input !== null) {
    const credTokens = collectCredentialTokens(step.input);
    if (credTokens.length > 0) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "call_input_credential_forbidden",
          message:
            "call input may not carry credential placeholders (it is persisted with the child execution): " +
            credTokens.join(", ") +
            " — reference the credential inside the called workflow instead",
        },
      };
    }
    const resolverCtx = {
      tenant_id: ctx.tenant_id,
      environment: ctx.execution_mode,
      db: ctx.db,
      input: (scope as Record<string, unknown>).$input,
      scope,
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    };
    const res = await resolvePlaceholdersTypePreserving(step.input, resolverCtx);
    if (res.unresolved.length > 0) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "call_input_unresolved",
          message:
            "call input has unresolved placeholders: " +
            res.unresolved.map((u: { token: string }) => u.token).join(", "),
        },
      };
    }
    resolvedInput = res.value;
  }

  try {
    const childDefinition = await resolveDefinition(db, ctx.tenant_id, {
      kind: "saved",
      workflow_id: targetId,
      ...(pinnedChildVersion ? { version_id: pinnedChildVersion } : {}),
    });
    if (
      ctx.execution_privacy !== "sensitive" &&
      childDefinition.def.execution_privacy === "sensitive"
    ) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "sensitive_execution_unsupported",
          message: "A sensitive child workflow requires a sensitive parent execution.",
        },
      };
    }
    const child = await runExecution({
      db,
      tenant_id: ctx.tenant_id,
      source: {
        kind: "saved",
        workflow_id: targetId,
        ...(childDefinition.workflow_version_id
          ? { version_id: childDefinition.workflow_version_id }
          : {}),
      },
      input: normalizeWorkflowRunInput(resolvedInput, childDefinition.def.input_schema) ?? null,
      options: {
        request_source: "tool-chain",
        parent_execution_id: ctx.execution_id,
        ...(authorityLink ? { authority_link: authorityLink } : {}),
        depth: ctx.depth + 1,
        signal: ctx.signal,
        trace_id: ctx.trace_id ?? null,
        execution_mode: ctx.execution_mode,
        ...(ctx.hold_writes ? { hold_writes: true } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        caller_context: ctx.caller_context ?? null,
        caller_origin: ctx.caller_origin ?? "unknown",
        execution_privacy: ctx.execution_privacy,
      },
    });
    return {
      status: child.status === "succeeded" ? "succeeded" : "failed",
      ...(child.warnings?.length ? { warnings: child.warnings } : {}),
      output: {
        execution_id: child.execution_id,
        status: child.status,
        output: child.output,
      },
      retry_count: 0,
      duration_ms: Date.now() - start,
      error:
        child.status === "succeeded"
          ? null
          : (child.error ?? {
              code: "child_failed",
              message: `child status ${child.status}`,
            }),
    };
  } catch (err) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "call_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export type { RunExecutionSource, WorkflowDef };
export { WorkflowDefSchema };
