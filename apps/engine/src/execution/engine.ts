// Execution engine entry point. `runExecution` walks the steps in
// declaration order (no DAG topo-sort yet — P3 ships linear pipelines
// plus branch/parallel/loop control hints). It:
//
//   1. creates an `executions` row (status=queued)
//   2. registers an AbortController under the execution id
//   3. transitions to `running` and emits `execution.started`
//   4. for each step: inserts an execution_steps row, runs the driver via
//      step-runner, applies onError semantics
//   5. transitions to a terminal state, audits + outbox-events, releases
//      the AbortController
//
// Tool chaining: a `call` step looks up the target workflow + version,
// invokes runExecution recursively with parent_execution_id set,
// request_source='tool-chain' and depth+1.

import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import { resolvePlaceholdersTypePreserving } from "../llm/substitution/resolver.ts";
import { logger } from "../logging/logger.ts";
import {
  recordForEachExecution,
  recordLoopIterationsOffloaded,
} from "../observability/instrumentation.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { recordExecutionOutcome } from "../self-healing/outcome-tracker.ts";
import { buildStepDag, type StepDag, topoSort } from "../workflows/dag.ts";
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
import { rollupConnectorResolutions } from "./engine/connector-rollup.ts";
import {
  bodyEnvelopeForLoopAccumulator,
  envelopeFor,
  type ScopeEnvelope,
  validateAgainstJsonSchema,
  wrapEnvelope,
} from "./engine/envelope.ts";
import { evaluate as evaluateJsonata } from "./jsonata-engine.ts";
import { buildLoopChildScope, resolveForEachCollection } from "./loop-scope.ts";
import { isOffloadRef, maybeOffload, previewOf } from "./offload.ts";
import { deepResolveOffloadRefs, previewOffloadRefs } from "./offload-rehydrate.ts";
import { checkOutputContract, summarizeViolations } from "./output-contract.ts";
import { type RunExecutionSource, resolveDefinition } from "./resolve-definition.ts";
import { applyResponseFilters } from "./response-filter.ts";
import {
  createExecution,
  finalizeExecution,
  finalizeStepRow,
  insertStepRow,
  markExecutionRunning,
} from "./state.ts";
import { runStep } from "./step-runner.ts";
import { classifyRequestStepSideEffects } from "./steps/request/side-effects.ts";
import { MAX_CALL_DEPTH, WORKFLOW_TIMEOUT_DEFAULT_MS } from "./timeouts.ts";
import {
  type ExecutionStatus,
  HELD_PREVIEW_WARNING_CODE,
  type RequestSource,
  type RunOptions,
  type RunResult,
  type StepResult,
  type StepRunContext,
} from "./types.ts";

export { rollupConnectorResolutions } from "./engine/connector-rollup.ts";
export type { ScopeEnvelope } from "./engine/envelope.ts";

/** Default upper bound on concurrent `for_each` iterations when the
 *  engine auto-selects parallelism (read-classified request bodies).
 *  Kept modest so an unattended fan-out cannot stampede a target API
 *  past its rate budget — the per-iteration 429/Retry-After path still
 *  applies on top. Authors opt into a higher bound via
 *  `step.for_each_concurrency`. */
const DEFAULT_FOR_EACH_CONCURRENCY = 8;

/**
 * Resolve how many `for_each` iterations may run concurrently.
 *
 *   - explicit `step.for_each_concurrency` (>= 1) always wins, clamped
 *     to the item count.
 *   - otherwise auto-select from the step's side-effect class: a
 *     READ-classified `request` body fans out at the default bound;
 *     write-classified requests and every non-request body (transform,
 *     …) stay strictly sequential (1).
 *
 * Reuses {@link classifyRequestStepSideEffects} — the single seam that
 * already owns read/write knowledge for HTTP/GraphQL/SQL/S3 plus the
 * author's `side_effects` override — rather than re-deriving a
 * method/keyword list here.
 */
export function resolveForEachConcurrency(step: StepDef, itemCount: number): number {
  if (itemCount <= 1) return 1;
  const explicit = (step as { for_each_concurrency?: number }).for_each_concurrency;
  if (explicit != null && explicit >= 1) return Math.min(explicit, itemCount);
  if (step.kind === "request" && classifyRequestStepSideEffects(step as RequestStep) === "read") {
    return Math.min(itemCount, DEFAULT_FOR_EACH_CONCURRENCY);
  }
  return 1;
}

/**
 * Hold-writes (Fix G): find the first DAG dependency of `stepId` whose
 * response data is missing because that dependency was held (a
 * write-classified step that materialized but never dispatched) or was
 * itself skipped for depending on one. Checks EVERY edge kind — a
 * data-flow reference to a held step means its placeholders cannot
 * resolve, and a containment edge to a skipped container (branch /
 * parallel / loop) means the container never ran. Returns the
 * dependency's id (for the skip label) or null.
 */
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
  /** Discriminated union: "saved" | "draft" | "step". The engine pipeline
   *  is identical for all three; only the origin differs. */
  source: RunExecutionSource;
  input: unknown;
  options?: RunOptions;
}

export async function runExecution(p: RunExecutionParams): Promise<RunResult> {
  const { db, tenant_id } = p;
  const opts: RunOptions = p.options ?? {};
  const normalizedInput = normalizeWorkflowRunInput(p.input);
  const depth = opts.depth ?? 0;
  if (depth > MAX_CALL_DEPTH) {
    throw new Error(`call chain depth exceeded ${MAX_CALL_DEPTH}`);
  }

  // Resolve the execution definition from one of three sources:
  //   saved — persisted workflow + current_version_id
  //   draft — inline WorkflowDef (validated, not persisted)
  //   step  — single StepDef wrapped as a one-step WorkflowDef
  const resolved = await resolveDefinition(db, tenant_id, p.source);
  const def = resolved.def;
  const workflow_id = resolved.workflow_id;
  const workflow_version_id = resolved.workflow_version_id;

  // Validate the run input BEFORE any side-effecting setup (execution row,
  // abort registration, total-timeout timer). The check is pure — it only
  // needs the normalized input and the def's schema — so an invalid input
  // throws here with zero side effects: no orphaned `running` row, no
  // leaked AbortController in the process-global registry, no armed 6h
  // timer. On the async (queue) path the pre-created row stays `queued`
  // and the worker's catch finalizes it to `failed`. Validate even when
  // input is null/undefined so a required-input workflow run with no input
  // (e.g. a schedule) fails fast and named, not deep inside a later step.
  if (def.input_schema) {
    const check = validateAgainstJsonSchema(normalizedInput, def.input_schema, "$input");
    if (!check.valid) {
      throw Object.assign(new Error(check.errors.join("; ")), {
        code: "input_schema_violation",
        details: check.errors,
      });
    }
  }

  const request_source: RequestSource = opts.request_source ?? "api";
  const parent_execution_id = opts.parent_execution_id ?? null;
  const execution_mode = opts.execution_mode ?? "dev";

  // Single execution instant: persisted as the row's `started_at` (via
  // markExecutionRunning) AND reused as the one clock every sandbox reads —
  // the per-step transforms (`ctx.started_at`) and the workflow-scope
  // output_transform/validation functions alike. So `sk.now()` mirrors the
  // execution's `started_at` and is identical across all sandboxes in a run
  // (`sk.uuid()` is stable via the `execution_id`-derived seed). A fresh
  // re-run gets its own instant — sk.now() is consistent within one run and
  // equals the persisted row, not byte-identical across separate runs.
  const execution_started_at_date = new Date();
  const execution_started_at = execution_started_at_date.getTime();

  // Persist queued execution row (unless one already exists — the queue
  // worker passes `existing_execution_id` so the HTTP-created row is
  // reused instead of spawning a new one). For draft / step runs the
  // workflow_id / workflow_version_id columns stay NULL.
  const execution_id = opts.existing_execution_id
    ? opts.existing_execution_id
    : await createExecution(db, {
        tenant_id,
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        workflow_version_id: resolved.persist_workflow_refs ? workflow_version_id : null,
        source_kind: resolved.source_kind,
        source_ref: resolved.source_ref,
        request_source,
        parent_execution_id,
        execution_mode,
        input: normalizedInput ?? null,
      });

  // Wire abort: external signal (if any) feeds into the per-execution
  // controller. The controller is registered so cancel API can find it.
  const ctrl = registerAbort(execution_id, tenant_id);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort("aborted");
    else opts.signal.addEventListener("abort", () => ctrl.abort("aborted"), { once: true });
  }
  const totalTimeoutCtrl = new AbortController();
  const totalTimer = setTimeout(
    () => totalTimeoutCtrl.abort("workflow_timeout"),
    def.timeout_ms ?? WORKFLOW_TIMEOUT_DEFAULT_MS,
  );
  const signal = combineSignals([ctrl.signal, totalTimeoutCtrl.signal]);

  const started = await markExecutionRunning(
    db,
    tenant_id,
    execution_id,
    execution_started_at_date,
  );
  if (!started) {
    // A durable cancel may win while the queue is handing this job to a
    // worker. Refuse the run before any step, completion audit, outcome
    // tracking, or workflow-recency mutation can occur. The cancel path owns
    // the terminal row; this worker only releases its process-local resources.
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
      actor_type: "system",
      action: AuditAction.EXECUTION_STARTED,
      resource_type: "execution",
      resource_id: execution_id,
      result: "success",
      metadata: {
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        source_kind: resolved.source_kind,
        request_source,
        parent_execution_id,
      },
    },
    db,
  );

  // Per-run LLM-token budget. The cap lives on the workflow def; null
  // means "no per-run cap" (the per-tenant monthly budget still
  // applies independently). Threaded through every StepRunContext so
  // drivers that issue an LLM-provider call can consult it.
  const llmBudget = new RunLlmBudget(def.max_llm_tokens_per_run ?? null);

  const scope: Record<string, unknown> = { $input: normalizedInput };

  let finalStatus: ExecutionStatus = "succeeded";
  const stepSummaries: RunResult["steps"] = [];
  let lastOutput: unknown = null;
  let lastError: { code: string; message: string } | null = null;
  // The step whose failure tripped the run — carried into the
  // `execution.failed` event so a notification names what broke.
  let failedStepId: string | null = null;
  // Populated by the workflow-level `validation_expression` check
  // when it returns a falsy verdict or throws. Used to surface a
  // typed `validation_failed` error on the run result so the
  // self-healing flow can act on it.
  let validationError: { code: string; message: string; details?: unknown } | null = null;
  const skippedStepIds = new Set<string>();
  // Hold-writes bookkeeping: ids of steps whose response data is
  // missing — either held (write materialized but never dispatched) or
  // skipped because a DAG dependency was held. Steps depending on this
  // set are skipped explicitly with the labeled
  // `skipped_dependency_held` error instead of failing deep in the
  // driver with `placeholder_unresolved`. Only consulted when
  // `opts.hold_writes` is set; live runs never touch it.
  const heldOrSkippedStepIds = new Set<string>();
  const warningsAccum: NonNullable<RunResult["warnings"]> = [];

  // Topologically sort the steps so a step that references
  // `$scope.<id>.data` runs AFTER `<id>` even when declared earlier.
  // The DAG combines data-flow refs with control-flow containment
  // (branch arms / parallel branches / loop bodies depend on their
  // container), so contained steps still run after their container —
  // identical semantics to the old linear walk for declaration-ordered
  // workflows, but correct ordering for forward-ref workflows. Cycles
  // are rejected at authoring time; a cycle here would have been
  // caught by build_workflow / dry_run_workflow / edit_workflow_patch.
  const dag = buildStepDag(def);
  const stepIndexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  let executionOrder: ReadonlyArray<string>;
  try {
    executionOrder = topoSort(dag);
  } catch (err) {
    // Should not be reachable — pre-flight cycle checks gate every
    // tool that produces a WorkflowDef. If a cycle slipped through,
    // fall back to declaration order so the run can still emit step
    // summaries (and the existing unresolved-identifier warnings will
    // surface the bug downstream). Log loudly so the contract violation
    // is visible in operator triage instead of disguising itself as a
    // generic step-resolution warning further down the run.
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

  // Static container-child exclusion: compute the union of ids that are
  // managed INSIDE their container driver and must not run at the top level.
  // Applies to: loop bodies (run by the loop driver per item) and parallel
  // branches (run by the parallel driver concurrently). Does NOT include
  // branch arms — branch arms execute in the top-level walk; only the
  // NOT-TAKEN arm is excluded at runtime via the `skippedStepIds` set that
  // is populated after the branch step reports which arm it chose.
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
      // Drain remaining steps as aborted summary entries.
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
    // Container children are excluded from the top-level walk — they run
    // inside their container (branch arm, parallel branch, loop body).
    // The static `containerChildIds` set catches them regardless of
    // container outcome (success, failure, held), fixing the bug where a
    // failed or held container left its children to run at top level with
    // unbound `$item`. The `skippedStepIds` set handles the branch arm
    // that was NOT taken (runtime control flow).
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
    // Step-output fixture short-circuit. Used by the dry-run cache so
    // re-previewing a draft where only a downstream transform changed
    // skips the unchanged upstream request entirely (session fb930dcb's
    // 12 identical Jira fetches). The caller is responsible for
    // selecting only deterministic steps (GETs, transforms, query-only
    // GraphQL); the engine writes the supplied envelope verbatim into
    // scope and records a synthetic step summary marked
    // `replayed_from_fixture: true` so consumers can tell.
    const fixtureEnvelope = opts.step_output_fixtures?.[step.id];
    if (fixtureEnvelope !== undefined) {
      const envObj = fixtureEnvelope as Record<string, unknown>;
      const fixtureData = (envObj as { data?: unknown }).data;
      scope[step.id] = fixtureEnvelope;
      lastOutput = fixtureData;
      // `output_preview` MUST mirror the normal path (line ~603), which
      // records the RAW step output — NOT the `{ data, … }` scope envelope.
      // The dry-run cache re-wraps `output_preview` into a fresh fixture
      // envelope (`{ data: output_preview }`) on the next iteration; if we
      // stored the already-enveloped `fixtureEnvelope` here, each rerun would
      // wrap one `.data` layer deeper — `$scope.<step>.data.slug` →
      // `.data.data.slug` → ad infinitum (SUBKIT_BUGS.md Bug 2, and the
      // root of Bugs 1 & 3, where URL/JSONata refs then point at the wrong
      // depth). Recording the unwrapped `fixtureData` keeps the replay path
      // idempotent with the live path: the cached shape never drifts.
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
    // Hold-writes: a step that depends (data-flow ref or containment)
    // on a held / held-skipped step cannot run — its scope key carries
    // no data. Skip it explicitly and labeled, mirroring the branch
    // control-flow skip shape, and propagate transitively.
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
      // One instant for the whole execution (== persisted row `started_at`),
      // shared by every step + the workflow-scope sandboxes.
      started_at: execution_started_at_date,
      workflow_slug: resolved.workflow_slug,
      trace_id: opts.trace_id ?? null,
      principal: opts.principal ?? null,
      execution_mode,
      step,
      step_index: i,
      step_row_id,
      llm_budget: llmBudget,
      persist_workflow_refs: resolved.persist_workflow_refs,
      ...(opts.hold_writes ? { hold_writes: true } : {}),
    };

    // for_each inline iteration: resolve the JS selector to an array,
    // then run THIS SAME step once per item with a child scope that
    // binds $item + $loop_index. The iteration results accumulate into
    // the same envelope shape as a legacy `loop` body, so downstream
    // transforms read `$scope.<step>.data[0].data` uniformly. The
    // container step row (inserted above) records the aggregate; each
    // iteration gets its own per-iteration row keyed `<step>[N]`.
    if (step.for_each) {
      const forEachStart = Date.now();
      const collectionResult = await resolveForEachCollection(
        step.for_each,
        step.id,
        scope,
        forEachStart,
        // Deterministic clock/id for `sk.now()`/`sk.uuid()` in the
        // selector — the execution's fixed instant + a per-step seed, same
        // wiring as steps/transform.ts.
        { now_ms: ctx.started_at.getTime(), seed: `${execution_id}:${step.id}` },
      );
      // Circuit-breaker preflight (audit H1): when the target connector's
      // breaker is already open, every iteration would fail fast with
      // `circuit_open` anyway — but each one still schedules, inserts its
      // own step row and reports its own failure (observed: a 5×-422 open
      // breaker turned one fan-out into 464 doomed step failures in 3.5
      // minutes). Fail ONCE at the container instead of scheduling N
      // branches. Half-open probing is untouched: past the reset window the
      // predicate stands down and the first iteration performs the probe.
      let fanOutCircuitFailure: StepResult | null = null;
      if (collectionResult.kind === "collection" && step.kind === "request" && step.connector_id) {
        const target = await getConnectorForEnvironment(
          tenant_id,
          step.connector_id,
          execution_mode,
          db,
        );
        if (target && isCircuitOpenBlocking(target)) {
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
        // Collection resolution failed (or the fan-out preflight tripped) —
        // record the failure as the step outcome, write the step row, and
        // apply the on_error semantics.
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
          { output_preview: null, result_preview: null, result_storage_uri: null },
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
                error: { code: "skipped", message: "skipped due to upstream failure" },
                request_meta: null,
              });
            }
            break;
          }
          // on_error:"continue" — author-declared tolerance. The run keeps
          // its succeeded status, so the failure surfaces as a warning
          // instead of on RunResult.error.
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
        // Selector resolved to non-array — zero iterations, warn.
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
          { output_preview: [], result_preview: null, result_storage_uri: null },
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
      // kind === "collection" — iterate. Iterations are independent:
      // each binds $item/$loop_index off the PARENT scope via
      // buildLoopChildScope, mutates only its own child scope, and
      // contributes one entry to a fixed result slot. That independence
      // lets a read-classified fan-out run with bounded concurrency
      // (resolveForEachConcurrency) while write/transform bodies stay
      // strictly sequential. Result order is preserved regardless —
      // every iteration writes its own index, never appends.
      const items = collectionResult.items;
      const slots: (Record<string, unknown> | undefined)[] = new Array(items.length);
      // First failed iteration body (status failed/aborted/timed_out). A
      // for_each runs THIS step once per item, so the iteration's failure
      // is the step's failure — without surfacing it the container always
      // finalized "succeeded" and a write that 400'd inside a loop body was
      // masked as a successful execution (silent data-loss class). The
      // single-threaded check-and-set is race-free across bounded-parallel
      // workers (no await between read and write).
      let forEachFailure: import("./step-runner.ts").RunStepOutcome | null = null;

      const runIteration = async (itemIdx: number): Promise<void> => {
        const item = items[itemIdx];
        // Pass a no-item_var loopStep shape so buildLoopChildScope only
        // binds the canonical $item + $loop_index — no legacy alias.
        const childScope = buildLoopChildScope({}, scope, item, itemIdx);
        const iterStepRowId = await insertStepRow(db, {
          tenant_id,
          execution_id,
          step_key: `${step.id}[${itemIdx}]`,
          step_index: i,
          kind: step.kind,
        });
        if (opts.hold_writes) {
          // The held decision is iteration-invariant — it depends only on
          // the global held/skipped set, not on sibling iterations — so
          // each iteration reads it read-only, the same contract parallel
          // branches use for `heldOrSkippedStepIds`.
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
          step_row_id: iterStepRowId,
        };
        const iterOutcome = await instrument({
          module: "execution",
          action: "step",
          level: "debug",
          thresholdMs: 1000,
          fields: { step_id: step.id, step_kind: step.kind, for_each_index: itemIdx },
          fn: () =>
            runStep(
              iterCtx,
              childScope,
              normalizedInput,
              async ({ ctx: cctx, step: cstep, scope: cscope }) =>
                runCallStep(db, cctx, cstep as CallStep, cscope),
            ),
        });
        // Retain $item + $loop_index on the scope for downstream
        // string/JSONata refs within this iteration. The child scope
        // already has them; the parent scope's step.id key carries the
        // aggregate after all iterations complete.
        childScope[step.id] = envelopeFor(iterOutcome);
        slots[itemIdx] = { [step.id]: bodyEnvelopeForLoopAccumulator(iterOutcome) };
        if (
          forEachFailure === null &&
          (iterOutcome.result.status === "failed" ||
            iterOutcome.result.status === "aborted" ||
            iterOutcome.result.status === "timed_out")
        ) {
          forEachFailure = iterOutcome;
        }
      };

      const concurrency = resolveForEachConcurrency(step, items.length);
      if (concurrency <= 1) {
        // Sequential: honour cooperative cancellation between iterations,
        // exactly as before.
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          if (signal.aborted) break;
          await runIteration(itemIdx);
        }
      } else {
        // Bounded-parallel: a fixed worker set pulls the next index off a
        // shared cursor, so at most `concurrency` iterations are in
        // flight at once. A mid-flight abort stops claiming new indices;
        // slots never claimed stay empty and compact out below.
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
      // Compact away any slots left empty by an abort; completed
      // iterations keep their original relative order.
      const iterationResults: unknown[] = slots.filter((s) => s !== undefined);
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
      // Empty-loop-body warning reuse: same heuristic as the legacy loop.
      if (iterationResults.length > 0) {
        let offloadedIterations = 0;
        const productiveIterations = iterationResults.filter((iter) => {
          if (!iter || typeof iter !== "object") return false;
          let iterProductive = false;
          let iterOffloaded = false;
          for (const value of Object.values(iter as Record<string, unknown>)) {
            const env = value as ScopeEnvelope | null | undefined;
            if (!env || typeof env !== "object") continue;
            if (env.held) {
              iterProductive = true;
              continue;
            }
            if (env.error) {
              if (env.error.code === "skipped_dependency_held") iterProductive = true;
              continue;
            }
            const data = env.data;
            if (data == null) continue;
            if (isOffloadRef(data)) {
              iterOffloaded = true;
              iterProductive = true;
              continue;
            }
            if (Array.isArray(data) && data.length === 0) continue;
            if (typeof data === "object" && Object.keys(data as object).length === 0) continue;
            iterProductive = true;
          }
          if (iterOffloaded) offloadedIterations += 1;
          return iterProductive;
        }).length;
        if (offloadedIterations > 0) {
          recordLoopIterationsOffloaded({ tenant_id, count: offloadedIterations });
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
      // A failed iteration body is the for_each's failure: report the
      // container's status as the failing iteration's status (not a blanket
      // "succeeded") so the step row, the step summary, and the execution
      // final_status all reflect it. on_error governs propagation exactly as
      // for a non-loop step.
      // The cast restores the declared union: TS resets `forEachFailure` to
      // `null` at this read because its only assignment lives in the
      // `runIteration` closure.
      const failedOutcome = forEachFailure as import("./step-runner.ts").RunStepOutcome | null;
      const forEachStatus: "succeeded" | "failed" | "aborted" | "timed_out" = failedOutcome
        ? (failedOutcome.result.status as "failed" | "aborted" | "timed_out")
        : "succeeded";
      const forEachError = failedOutcome
        ? (failedOutcome.result.error ?? { code: "loop_body_failed", message: "loop body failed" })
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
        const stepError = forEachError ?? { code: "step_failed", message: "step failed" };
        if (onError === "fail") {
          lastError = stepError;
          failedStepId = step.id;
          if (forEachStatus === "aborted") finalStatus = "aborted";
          else if (forEachStatus === "timed_out") finalStatus = "timed_out";
          else finalStatus = "failed";
          // Mark every remaining step in the topological order as skipped —
          // same contract as the shared post-step failure handling below.
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
              error: { code: "skipped", message: "skipped due to upstream failure" },
              request_meta: null,
            });
          }
          break;
        }
        // on_error:"continue" — author-declared tolerance. The run keeps
        // its succeeded status, so the failure surfaces as a warning
        // instead of on RunResult.error.
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
    // Wrap every step's output in the documented envelope
    //   { data, status_code?, headers?, duration_ms, error? }
    // so transforms can read `$scope.<id>.data` — the contract the
    // data-handling skill has promised forever but the runtime used to
    // ignore (stepId was the raw body). Loop/branch/parallel keep their
    // special array/record shape under `.data` too so authors can write
    // `$scope.each.data.length` etc. uniformly.
    scope[step.id] = envelopeFor(outcome);
    lastOutput = outcome.scope_value;
    // Hold-writes: a held step's response data does not exist — record
    // it so downstream dependents skip explicitly (see the labeled
    // skip above) instead of resolving placeholders against null.
    if (outcome.result.held) {
      heldOrSkippedStepIds.add(step.id);
    }
    if (outcome.result.warnings?.length) {
      for (const w of outcome.result.warnings) {
        warningsAccum.push({ ...w, step_key: step.id });
      }
    }

    // Branch control flow: mark skipped arm's steps so they are skipped in the
    // linear walk.
    if (step.kind === "branch" && outcome.result.status === "succeeded") {
      const arm = (outcome.result.output as { arm?: string })?.arm;
      const branchStep = step as BranchStep;
      const skip = arm === "then" ? (branchStep.else_steps ?? []) : (branchStep.then_steps ?? []);
      for (const skipId of skip) {
        skippedStepIds.add(skipId);
      }
    }

    // Loop iteration: after the loop driver resolves the collection, iterate
    // each item through the body steps sequentially.
    if (step.kind === "loop" && outcome.result.status === "succeeded") {
      const loopStep = step as LoopStep;
      const items = outcome.result.output;
      if (Array.isArray(items)) {
        const iterationResults: unknown[] = [];
        // First failed body step (status failed/aborted/timed_out) whose own
        // on_error is the default "fail". Pre-fix a write that 400'd inside a
        // loop body was stored only in the per-iteration envelope and never
        // propagated to the execution's final_status — the loop driver's
        // outcome stayed "succeeded" (it only resolves the collection), so an
        // operator saw `succeeded` over silently lost writes. A body step that
        // sets on_error:"continue" opts out of this, exactly as in the linear
        // walk.
        let loopBodyFailure: { step_id: string; result: import("./types.ts").StepResult } | null =
          null;
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const childScope = buildLoopChildScope(loopStep, scope, item, itemIdx);
          const bodyResults: Record<string, unknown> = {};
          // Hold-writes: held body steps hold PER ITERATION — each
          // iteration materializes its own held_request from its own
          // `$item`. The set resets every iteration so a body step
          // depending on a held sibling is skipped within THIS
          // iteration only.
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
              started_at: new Date(),
              workflow_slug: resolved.workflow_slug,
              trace_id: opts.trace_id ?? null,
              principal: opts.principal ?? null,
              execution_mode,
              step: bodyStep,
              step_index: i,
              step_row_id: bodyStepRowId,
              llm_budget: llmBudget,
              persist_workflow_refs: resolved.persist_workflow_refs,
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
            // Per-iteration trace: surface the post-substitution URL +
            // status + outcome so an operator (or the LLM author reading
            // diagnose_run) can see which iteration of which body step
            // ran where. Pre-fix the engine logged only the unresolved
            // template, leaving session f00b8d1c blind to which item
            // produced the 404. Best-effort — only fires on HTTP-shaped
            // request_meta variants where a resolved URL exists.
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
            // Full envelope in `childScope` so later body steps in THIS
            // iteration can read `$scope.<id>.data`. `bodyResults`
            // accumulates into the run-resident `iterationResults`, so it
            // gets the OffloadRef-swapped envelope: a large body payload
            // is replaced by a reference to its already-persisted
            // storage_uri (no second write), bounding loop memory.
            childScope[bodyStep.id] = envelopeFor(bodyOutcome);
            bodyResults[bodyStep.id] = bodyEnvelopeForLoopAccumulator(bodyOutcome);
            // Hold-writes: per-iteration held tracking — siblings later
            // in THIS iteration's body skip explicitly. The envelopes
            // above already carry `held` + `held_request` (envelopeFor)
            // so each iteration's artifact rides the loop accumulator.
            if (bodyOutcome.result.held) {
              iterationHeldIds.add(bodyStep.id);
            }
            const bodyFailed =
              bodyOutcome.result.status === "failed" ||
              bodyOutcome.result.status === "aborted" ||
              bodyOutcome.result.status === "timed_out";
            if (bodyFailed && (bodyStep.on_error ?? "fail") === "fail") {
              if (loopBodyFailure === null) {
                loopBodyFailure = { step_id: bodyStep.id, result: bodyOutcome.result };
              }
              if (loopStep.fail_fast === true) break;
            } else if (bodyFailed) {
              // on_error:"continue" on the body step — the container stays
              // green, so the tolerated failure surfaces as a warning
              // instead of on RunResult.error. Once per body step, not
              // once per iteration.
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
        lastOutput = iterationResults;
        // Empty-loop-body detection (P2): the loop driver produced N
        // items, every body step "succeeded", but no iteration's body
        // output carried a productive payload. Without this signal the
        // workflow reports `succeeded` and the LLM truthfully claims
        // "loop completed" while the user sees zero rows — the
        // session-79bf2cca false-positive. Emit a structured warning
        // with the actual envelope shape so the LLM can fix its
        // JSONata next turn instead of guessing.
        if (iterationResults.length > 0) {
          // Count offloaded iterations alongside productive ones — an
          // iteration whose body payload was offloaded to durable
          // storage holds an `OffloadRef` in the run-resident scope
          // instead of the full envelope (the OOM fix). Surfacing the
          // tally as a metric makes big-loop memory pressure
          // observable to operators.
          let offloadedIterations = 0;
          const productiveIterations = iterationResults.filter((iter) => {
            if (!iter || typeof iter !== "object") return false;
            let iterProductive = false;
            let iterOffloaded = false;
            for (const value of Object.values(iter as Record<string, unknown>)) {
              const env = value as ScopeEnvelope | null | undefined;
              if (!env || typeof env !== "object") continue;
              // Hold-writes preview: a held body step carries no data BY
              // DESIGN (the artifact rides held_request), and a sibling
              // skipped for depending on it is equally intentional —
              // neither must trip the empty-loop heuristic during a
              // hold preview of an all-writes loop body.
              if (env.held) {
                iterProductive = true;
                continue;
              }
              if (env.error) {
                if (env.error.code === "skipped_dependency_held") iterProductive = true;
                continue;
              }
              const data = env.data;
              if (data == null) continue;
              // An offloaded body payload appears as an `OffloadRef`.
              // It is productive by definition (only oversize payloads
              // offload) — count it without re-hydrating.
              if (isOffloadRef(data)) {
                iterOffloaded = true;
                iterProductive = true;
                continue;
              }
              if (Array.isArray(data) && data.length === 0) continue;
              if (typeof data === "object" && Object.keys(data as object).length === 0) continue;
              iterProductive = true;
            }
            if (iterOffloaded) offloadedIterations += 1;
            return iterProductive;
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
        // Surface a failed loop-body step as the loop's outcome so the shared
        // post-step handling below propagates it to final_status (honouring
        // the LOOP step's on_error). The per-iteration envelopes already carry
        // each iteration's error under `$scope.<loop>.data[i]`; here we only
        // flip the container status that was masked as "succeeded".
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

    // Parallel fan-out: run each branch concurrently via Promise.all.
    if (step.kind === "parallel" && outcome.result.status === "succeeded") {
      const parallelStep = step as ParallelStep;
      const branchResults = await instrument({
        module: "execution",
        action: "parallel",
        memory: true,
        fields: { step_id: step.id, branch_count: parallelStep.branches.length },
        fn: () =>
          Promise.all(
            parallelStep.branches.map(async (branchStepIds) => {
              const branchScope: Record<string, unknown> = { ...scope };
              const branchOutput: Record<string, unknown> = {};
              // Hold-writes: per-branch held tracking, same contract as
              // the loop-body iteration set above. The global set is
              // only read here (branches run concurrently).
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
                  started_at: new Date(),
                  workflow_slug: resolved.workflow_slug,
                  trace_id: opts.trace_id ?? null,
                  principal: opts.principal ?? null,
                  execution_mode,
                  step: branchStepDef,
                  step_index: i,
                  step_row_id: branchStepRowId,
                  llm_budget: llmBudget,
                  persist_workflow_refs: resolved.persist_workflow_refs,
                  ...(opts.hold_writes ? { hold_writes: true } : {}),
                };
                const branchOutcome = await instrument({
                  module: "execution",
                  action: "step",
                  level: "debug",
                  thresholdMs: 1000,
                  fields: { step_id: branchStepDef.id, step_kind: branchStepDef.kind },
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
                branchOutput[branchStepId] = envelopeFor(branchOutcome);
                if (branchOutcome.result.held) {
                  branchHeldIds.add(branchStepId);
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
    }

    // Capture an output preview for this step. For request/transform/
    // simple steps we use the raw `outcome.result.output`; for loop +
    // parallel we use the just-assembled scope envelope which carries
    // the iterationResults / branchResults so downstream transforms
    // can be authored against the canonical shape. Truncated downstream by previewOf when
    // serialised for the LLM.
    let outputPreview: unknown = outcome.result.output;
    if (step.kind === "loop" || step.kind === "parallel") {
      const wrapped = scope[step.id] as { data?: unknown } | undefined;
      if (wrapped && typeof wrapped === "object" && "data" in wrapped) {
        // For a loop, `wrapped.data` (iterationResults) may embed
        // `OffloadRef` placeholders. The step summary is a preview
        // surface for the LLM — collapse each ref to its inline
        // `preview` string rather than re-hydrating from storage.
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
      const stepError = outcome.result.error ?? { code: "step_failed", message: "step failed" };
      if (onError === "fail") {
        lastError = stepError;
        failedStepId = step.id;
        if (outcome.result.status === "aborted") finalStatus = "aborted";
        else if (outcome.result.status === "timed_out") finalStatus = "timed_out";
        else finalStatus = "failed";
        // Mark every remaining step in the topological order as skipped.
        // Iterating `executionOrder` rather than the raw declaration array
        // ensures contained branch arms / parallel branches that haven't been
        // visited yet still surface a summary entry — and we don't
        // double-count any step already executed earlier in the topo walk.
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
            error: { code: "skipped", message: "skipped due to upstream failure" },
            request_meta: null,
          });
        }
        break;
      }
      // continue mode: keep scope value; the run keeps its succeeded
      // status, so the failure surfaces as a warning instead of on
      // RunResult.error (author-declared tolerance).
      warningsAccum.push({
        code: "step_failed_continued",
        step_key: step.id,
        message: `step "${step.id}" ${outcome.result.status} (${stepError.code}: ${stepError.message}) but declares on_error:"continue" — the run continued`,
        details: { step_status: outcome.result.status, error_code: stepError.code },
      });
    }
  }

  // Re-hydrate any `OffloadRef` placeholders in the final output BEFORE
  // output_transform / response_filters / output_schema / validation /
  // the aggregate `maybeOffload`. The loop runner keeps `iterationResults`
  // bounded by substituting refs (the OOM fix); here — once — we resolve
  // them so downstream consumers and the PERSISTED result see plain JSON.
  // An `OffloadRef` must never cross an external surface. A re-hydration
  // failure throws `OffloadResolutionError`, failing the run.
  if (lastOutput !== undefined && lastOutput !== null) {
    try {
      lastOutput = await deepResolveOffloadRefs(db, tenant_id, lastOutput, signal);
    } catch (err) {
      // A re-hydration failure must NOT bubble out of `runExecution` as
      // an unhandled 500 — it has to be audited as a proper failed
      // execution record, the same shape as an output_transform throw
      // just below. Stamp the typed error and fall through to the
      // persistence layer. The error `.message` is already REDACTED to
      // the locator scheme by `OffloadResolutionError`.
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

  // Optional final-output transform. The two forms are mutually
  // exclusive at authoring time (Zod superRefine), so exactly one
  // branch runs per workflow:
  //   - `output_transform` (JSONata)
  //   - `output_transform_function` (JS, evaluated in QuickJS)
  // Both shape the workflow's public payload BEFORE output_schema /
  // validation_expression / validation_function gate the returned
  // value.
  if (lastOutput !== undefined && finalStatus === "succeeded") {
    if (def.output_transform) {
      try {
        // Bind `$scope` + `$input` exactly like transform STEPS do
        // (jsonata-bindings.buildJsonataBindings). Without these bindings the
        // output_transform could only see the last step's output as the bare
        // root — every `$scope.<step>.data…` reference resolved to nothing, so
        // an object-constructor transform collapsed to `{}` even though all
        // steps succeeded (the `wf_<slug>` envelope returned `{}` while
        // inspect_execution showed the real per-step data). `lastOutput`
        // stays the data root so bare-path transforms keep working.
        const transformed = await evaluateJsonata(def.output_transform, lastOutput, {
          input: normalizedInput,
          scope,
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
          clock: { now_ms: execution_started_at, seed: `${execution_id}:output_transform` },
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

  // Workflow-level response filters. Run AFTER output_transform so the
  // operator-defined transform shapes the payload first, then filters
  // mask/redact/strip last. Per-step filters on individual
  // `RequestStep.response_filters`
  // already cleaned each step's HTTP response inline; this layer is
  // the last gate before the payload crosses the tenant boundary.
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

  // Workflow output contract (Fix 11). Validate the FINAL output (post
  // output_transform / response_filters) against the definition's
  // declared `output_schema` via the shared Ajv validator. NON-blocking
  // on live runs: the run stays succeeded and the violation rides
  // `RunResult.warnings` with field-level `$output/...` paths — the
  // dry-run preview is where the same code blocks (auto-commit refusal
  // in dry_run_workflow). A schema that fails to compile is an
  // authoring bug the workflow validator gate should have refused;
  // log-only here.
  // Hold-writes interplay: the contract asserts the LIVE final output.
  // When a hold-writes preview held (or hold-skipped) any step, the real
  // final output cannot exist by design — `lastOutput` is null for a
  // held terminal step, or a stale upstream value when the terminal step
  // was skipped behind a hold. Validating that against the schema would
  // make every preview of a send-terminated workflow permanently red.
  // Skip with an explicit log; live runs and hold-free previews still
  // validate.
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
  // Honest preview (Fix A). When a hold-writes preview held a write — or
  // skipped a step behind a held write — the run still reports
  // `succeeded`, and `lastOutput` is whatever upstream read/transform last
  // produced. Without a signal this is indistinguishable from a real run:
  // exactly the "gemeldet ≠ geschrieben" no-op (a search-over-POST held →
  // the whole write chain skipped → the caller saw the converted blocks
  // and reported success while nothing was written). Emit a MANDATORY
  // warning (rides RunResult.warnings → the MCP envelope) so the caller
  // knows nothing was persisted. The warning states the STATE only — the
  // remedy is a tool argument (`execute_writes`) or an approval handle
  // (`confirm_id`), and only the tool surface knows which of the two it
  // publishes. Step ids + method/url only — never the (already-redacted)
  // held bodies.
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
        `Preview run (hold_writes): ${heldWriteSteps.length} write step(s) held` +
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
  if (
    def.output_schema &&
    lastOutput !== undefined &&
    finalStatus === "succeeded" &&
    !outputUnavailableDueToHolds
  ) {
    const contract = checkOutputContract(lastOutput, def.output_schema);
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

  // Optional `validation_expression` — evaluated AFTER output_schema so
  // shape errors surface first. A falsy result trips finalStatus to
  // failed and stamps the typed `validation_failed` error code; the
  // self-healing flow recognises this code and produces a
  // `validation_failed` drift signal that carries the expression text
  // and the offending value, so the repair LLM can propose a patch.
  if (def.validation_expression && lastOutput !== undefined && finalStatus === "succeeded") {
    try {
      // Same binding fix as output_transform above — a validation_expression
      // that references `$scope.<step>` or `$input` must resolve them, not
      // silently see `undefined` (which is falsy → spurious validation_failed).
      const verdict = await evaluateJsonata(def.validation_expression, lastOutput, {
        input: normalizedInput,
        scope,
      });
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

  // Optional `validation_function` — JS escape hatch for invariants
  // JSONata can't express. Runs in the QuickJS sandbox with the
  // final output bound as `input`. A `false` return (or any throw)
  // trips the same `validation_failed` envelope.
  if (def.validation_function && lastOutput !== undefined && finalStatus === "succeeded") {
    try {
      const result = await runJs<unknown>({
        code: def.validation_function,
        input: lastOutput,
        clock: { now_ms: execution_started_at, seed: `${execution_id}:validation` },
      });
      const verdict = result.output;
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
  // Re-evaluate finalStatus if total timeout fired.
  if (totalTimeoutCtrl.signal.aborted && finalStatus === "succeeded") {
    finalStatus = "timed_out";
  }
  if (ctrl.signal.aborted && finalStatus === "succeeded") {
    finalStatus = "aborted";
  }

  // Offload top-level execution result.
  const offload = await maybeOffload(db, {
    tenant_id,
    execution_id,
    step_id: null,
    result: lastOutput ?? null,
  });
  void previewOf; // re-export safety

  // Persist the same error the RunResult envelope reports below:
  // workflow-level validation/offload failures take precedence over the
  // last step error, so a run that failed validation (with every step
  // green) records the typed `validation_failed` code instead of null.
  const failureDetail = validationError ?? lastError;
  await finalizeExecution(
    db,
    tenant_id,
    execution_id,
    finalStatus,
    offload.storage_uri,
    finalStatus !== "succeeded" && failureDetail
      ? {
          step_id: failedStepId,
          error_code: failureDetail.code,
          error_message: failureDetail.message,
        }
      : null,
  );
  // Closed-loop patch-candidate outcome tracking: every finalised
  // execution updates any open outcome window for this workflow so
  // operators can see whether a recently-applied patch actually
  // prevented recurrence. Best-effort — tracker swallows errors.
  //
  // The optional `self_healing.enabled = false` opt-out lets the eval
  // runner compare `mode=one_shot` against `mode=self_healing` against
  // the same fixture. When unset the engine falls back to the tenant
  // policy resolved by the self-healing service itself.
  if (opts.self_healing?.enabled !== false) {
    await recordExecutionOutcome(
      {
        tenant_id,
        workflow_id,
        outcome: finalStatus === "succeeded" ? "success" : "failure",
      },
      db,
    );
  }
  // Touch `last_executed_at` for saved runs so the `wf_<slug>` tool
  // catalog can rank by recency. Drafts and one-shot step runs do not
  // touch a persisted workflow row.
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
      // SRE dashboards page on a non-zero rate — catalog LRU silently
      // degrades when this drifts, so make it observable.
      try {
        getMetrics().inc(METRIC_NAMES.WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL, {
          tenant_id,
        });
      } catch {
        // metrics inc is itself best-effort; never let it mask the run.
      }
    }
  }
  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
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
        // Cumulative LLM-provider tokens consumed across every
        // request step the run dispatched. Always emitted (even on
        // runs that issued zero LLM calls) so dashboards can plot a
        // per-tenant burn-down without having to filter on action.
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
    // Workflow-level `validation_expression` failures take precedence
    // over step-level errors on the result envelope: if the steps
    // succeeded but the invariant didn't hold, the operator and the
    // self-healing flow need to see the typed `validation_failed`
    // code, not whatever the last step happened to be.
    error: validationError
      ? { code: validationError.code, message: validationError.message }
      : lastError,
    steps: stepSummaries,
  };
  const resolutions = rollupConnectorResolutions(stepSummaries, execution_mode);
  if (resolutions.length > 0) runResult.connector_resolutions = resolutions;
  if (warningsAccum.length > 0) runResult.warnings = warningsAccum;
  return runResult;
}

/** Extract one ConnectorResolutionSummary per unique connector id from the
 *  step summaries. Each request/graphql step writes a `connector` sub-object
 *  into `request_meta`; this rollup dedupes so the operator sees one row per
 *  connector regardless of how many steps touched it. First occurrence wins
 *  — the step_key on the summary is the first step that used that connector.
 *  Exported for unit testing. */
/** Every `${cred.…}` token anywhere in a value, by raw name. Walks the whole
 *  structure because the token can sit at any depth of the call input. */
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

// `scope` is REQUIRED, deliberately. It arrived optional so a caller without one
// would keep the old behaviour — but the old behaviour is the defect this fixes:
// no scope means `${scope.…}` and `${input.…}` reach the child as literal text,
// and that failure is silent at the boundary (the child receives a plausible
// string and fails later, somewhere else). All four call sites already pass it;
// making it required means a fifth cannot quietly opt back into the bug.
async function runCallStep(
  db: Db,
  ctx: StepRunContext,
  step: CallStep,
  scope: Record<string, unknown>,
): Promise<StepResult> {
  const start = Date.now();
  if (ctx.depth + 1 > MAX_CALL_DEPTH) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "call_depth_exceeded", message: `max call depth ${MAX_CALL_DEPTH}` },
    };
  }
  // Resolve target workflow id by id or slug.
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
  // Interpolate the call input against the caller's scope. Type-preserving
  // because a resolved `${scope.x.data.ids}` must reach the child as an array,
  // not as its JSON text — the same reason the request body uses this walker.
  let resolvedInput: unknown = step.input ?? null;
  if (step.input !== undefined && step.input !== null) {
    // A credential must not travel through a call input, because unlike a
    // request body this value is PERSISTED: `createExecution` stores the child's
    // input verbatim so a rerun can default to it, and the execution read schema
    // serves that column to anything holding execution:read — including the
    // read-and-execute MCP tier. Resolving `${cred.…}` here would write a secret
    // in clear text into a row that outlives the run and is visible from a lower
    // tier than the one that could read the credential in the first place.
    //
    // Refusing costs nothing: a child resolves `${cred.…}` itself, against its
    // own connectors, at the step that actually needs it. The parent never has
    // to hand it over.
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
    const child = await runExecution({
      db,
      tenant_id: ctx.tenant_id,
      source: { kind: "saved", workflow_id: targetId },
      input: resolvedInput,
      options: {
        request_source: "tool-chain",
        parent_execution_id: ctx.execution_id,
        depth: ctx.depth + 1,
        signal: ctx.signal,
        trace_id: ctx.trace_id ?? null,
        execution_mode: ctx.execution_mode,
        // Hold-writes propagates into tool-chained child runs — a
        // preview must not leak a write through a `call` step.
        ...(ctx.hold_writes ? { hold_writes: true } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
      },
    });
    return {
      status: child.status === "succeeded" ? "succeeded" : "failed",
      output: { execution_id: child.execution_id, status: child.status, output: child.output },
      retry_count: 0,
      duration_ms: Date.now() - start,
      error:
        child.status === "succeeded"
          ? null
          : (child.error ?? { code: "child_failed", message: `child status ${child.status}` }),
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
// Re-export the schema so consumers (workflow service) can validate.
export { WorkflowDefSchema };
