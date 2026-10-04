import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { resolveDryRunEnvironment } from "../../credentials/service.ts";
import { conversationToolCalls } from "../../db/schema/index.ts";
import type { PreviewStepSummary } from "../../execution/classify.ts";
import { classifyRunResult } from "../../execution/classify.ts";
import { runExecution } from "../../execution/engine.ts";
import { logger } from "../../logging/logger.ts";
import {
  recordAuthoringGateBlock,
  recordExecutionDryRun,
  recordExecutionWarningsEmitted,
} from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import {
  describeStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { StepDef, WorkflowDef } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withJudgeBreaker, withLatestPreview } from "../authoring-state.ts";
import { proposeDryRunRepairs } from "../dry-run-repair.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import type { PreviewJudgeOutcome } from "../preview-judge.ts";
import { runPreviewJudgeGate } from "../preview-judge-gate.ts";
import { computeScopeDriftWarnings } from "../scope-drift.ts";
import { stampStepTraceFingerprints } from "../step-fingerprint.ts";
import type { JudgeBreakerState } from "../types.ts";
import { authorConnectorWriteWarnings } from "./author-build-warnings.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import { draftPreviewInput } from "./draft-preview-input.ts";
import {
  buildDryRunCacheKey,
  buildStepPrefixHash,
  isStepKindCacheable,
  readDryRunCache,
  readStepFixture,
  writeDryRunCache,
  writeStepFixture,
} from "./dry-run-cache.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { classifyStepReferences } from "./inherited-step-references.ts";
import { recordLastPreview } from "./last-preview-store.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { previewEvidence } from "./preview-evidence.ts";
import { replacesPersistedWorkflow } from "./state-gate.ts";
import { buildRawStepResults } from "./step-results.ts";
import { truncateStepPreviewForLlm } from "./truncate.ts";
import { unverifiedBoundaries } from "./unverified-boundaries.ts";

const inputSchema = z
  .object({
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
    include_step_results: z
      .boolean()
      .optional()
      .describe(
        "Attach a `step_results` array carrying the RAW per-step input (the resolved request the step issued, or the held request for a write) side-by-side with its output. Default false keeps the envelope compact (the truncated `step_trace`). Turn on to self-diagnose whether a bad final output is a step-config bug (the request went out wrong) or an output_transform bug (the step was fine, the projection dropped the data).",
      ),
  })
  .openapi("DryRunWorkflowToolInput");

export const dryRunWorkflowTool: ConversationTool = {
  name: "dry_run_workflow",
  description:
    "Run the entire draft workflow via runExecution (source=draft), producing an auditable executions row. Read steps execute for real; WRITE steps are always HELD — resolved for inspection but never dispatched. Live writes require an immutable saved workflow version and its bounded execution or prepared one-shot approval. Omit input when repairing an existing scheduled workflow: the engine reuses its single enabled schedule in this environment. Explicit input, including {}, is preserved. Never invent dummy identifiers or destinations for real read requests. External destinations must come from the user, never fabricated placeholders.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = getWorkflowDraft(ctx.getDraft());
    const validation = validateWorkflowDef(draft);
    if (!validation.ok) {
      const invalidStepId =
        typeof draft.steps[0]?.id === "string" ? draft.steps[0].id : "(invalid-draft)";
      const nextDraft = withLatestPreview(
        ctx.getDraft(),
        {
          ok: false,
          step_id: invalidStepId,
          summary: "Preview blocked until the workflow draft validates cleanly.",
          preview: null,
        },
        "dry_run_workflow",
        "workflow_previewed",
      );
      await ctx.setDraft(nextDraft);
      return {
        ok: false,
        data: buildLifecyclePayload(nextDraft, {
          name: draft.name,
          errors: validation.errors,
          steps: draft.steps.length,
          summary: "Preview blocked until the workflow draft validates cleanly.",
        }),
      };
    }
    const steps = draft.steps.filter(
      (candidate): candidate is StepDef =>
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as { kind?: unknown }).kind === "string",
    );
    if (steps.length === 0) {
      return {
        ok: false,
        data: {
          error: "workflow draft has no runnable steps",
          reason: "empty_draft",
        },
      };
    }

    {
      const dag = buildStepDag({ name: draft.name ?? "draft", steps });
      const cycleReport = detectCycles(dag);
      if (cycleReport.has_cycle) {
        recordAuthoringGateBlock({ code: "workflow_cycle_detected", tool: "dry_run_workflow" });
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "workflow_cycle_detected",
            message: `workflow has a cyclic step dependency: ${renderCycleReport(cycleReport)}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
            extra: {
              cycles: cycleReport.cycles,
            },
          }),
        };
      }
    }

    {
      const placeholderErrors = validateUnsupportedPlaceholders({
        name: draft.name ?? "draft",
        steps,
      });
      if (placeholderErrors.length > 0) {
        const summary = placeholderErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field}: \`${e.raw}\` (${e.code}) → use \`${e.did_you_mean}\``,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unsupported_placeholder",
          tool: "dry_run_workflow",
        });
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "workflow_unsupported_placeholder",
            message: `workflow contains placeholder forms the runtime will not substitute: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
            extra: {
              unsupported_placeholders: placeholderErrors,
            },
          }),
        };
      }
    }

    const references = await classifyStepReferences(ctx, "dry_run_workflow", {
      name: draft.name ?? "draft",
      ...(draft.slug ? { slug: draft.slug } : {}),
      steps,
    } as WorkflowDef);
    if (references.introduced.length > 0) {
      recordAuthoringGateBlock({
        code: "workflow_unresolved_step_reference",
        tool: "dry_run_workflow",
      });
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "workflow_unresolved_step_reference",
          message: `workflow has unresolved step references: ${describeStepReferences(references.introduced)}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
          extra: {
            unresolved_references: references.introduced,
            ...(references.notice ? { inherited_step_references: references.notice } : {}),
          },
        }),
      };
    }
    const inheritedReferencesField = references.notice
      ? { inherited_step_references: references.notice }
      : {};

    const author = await resolveConversationPrincipal(ctx);
    const authorPermissionWarnings = author
      ? await authorConnectorWriteWarnings(
          ctx.db,
          author,
          ctx.tenant_id,
          steps as unknown as Array<Record<string, unknown>>,
        )
      : [];

    const REPEATING_REPAIR_CODES = new Set([
      "unresolved_identifier",
      "loop_over_unresolved",
      "transform_empty_extraction",
    ]);
    try {
      const rows = await ctx.db
        .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, ctx.tenant_id),
            eq(conversationToolCalls.conversation_id, ctx.conversation_id),
          ),
        )
        .orderBy(desc(conversationToolCalls.created_at))
        .limit(8);
      const codeCounts = new Map<string, number>();
      for (const r of rows) {
        if (r.tool !== "dry_run_workflow" && r.tool !== "run_workflow") continue;
        const data = r.output as { data?: { warnings?: Array<{ code?: unknown }> } } | null;
        const ws = data?.data?.warnings;
        if (!Array.isArray(ws)) continue;
        for (const w of ws) {
          if (w && typeof w.code === "string" && REPEATING_REPAIR_CODES.has(w.code)) {
            codeCounts.set(w.code, (codeCounts.get(w.code) ?? 0) + 1);
          }
        }
      }
      const trippedCodes = [...codeCounts.entries()]
        .filter(([, n]) => n >= 3)
        .map(([code, n]) => ({ code, count: n }));
      if (trippedCodes.length > 0) {
        logger.warn({
          module: "conversation_tool",
          action: "dry_run_workflow.repair_loop_detected",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tripped_codes: trippedCodes,
        });
        const codesPretty = trippedCodes.map((c) => `\`${c.code}\` × ${c.count}`).join(", ");
        recordAuthoringGateBlock({ code: "repair_loop_detected", tool: "dry_run_workflow" });
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "repair_loop_detected",
            message: `stop — three or more previews in a row produced the same authoring-bug warning(s): ${codesPretty}. Re-reading the data-handling skill, asking the user for a clarification, or proposing a structurally different draft is the right move. Another preview with the same draft will produce the same warning.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "ask_user_text",
              "load_skill",
              "search_knowledge",
              "inspect_workflow_draft",
              "edit_workflow_patch",
            ],
            extra: { tripped_codes: trippedCodes },
          }),
        };
      }
    } catch (err) {
      logger.warn({
        module: "conversation_tool",
        action: "dry_run_workflow.repair_loop_query_failed",
        msg: "repair-loop history query failed; circuit-breaker check skipped this turn",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const definition = {
      name: draft.name ?? "draft",
      steps,
      ...(typeof draft.output_transform === "string" && draft.output_transform.length > 0
        ? { output_transform: draft.output_transform }
        : {}),
      ...(draft.output_schema ? { output_schema: draft.output_schema } : {}),
    };
    const signal = ctx.abortSignal;

    const effectiveEnvironment = await resolveDryRunEnvironment({
      tenant_id: ctx.tenant_id,
      steps,
      requested: args.environment,
      exec: ctx.db,
      conversation_id: ctx.conversation_id,
      onLog: ctx.onLog,
    });

    let previewInput: unknown;
    try {
      previewInput = await draftPreviewInput(
        ctx.db,
        ctx.tenant_id,
        ctx.getDraft(),
        effectiveEnvironment,
        args.input,
      );
    } catch (error) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "preview_input_unavailable",
          message:
            error instanceof Error ? error.message : "Could not resolve saved preview inputs",
          next_best_actions: ["list_schedules", "ask_user_form"],
        }),
      };
    }

    ctx.onLog?.(
      "info",
      `dry-running ${steps.length} step${steps.length === 1 ? "" : "s"} (env=${effectiveEnvironment})`,
    );
    const cacheKey = buildDryRunCacheKey({
      tenant_id: ctx.tenant_id,
      execution_mode: effectiveEnvironment,
      draft: definition,
      input: previewInput ?? null,
    });
    const cached = readDryRunCache(cacheKey);
    let run: Awaited<ReturnType<typeof runExecution>>;
    let prefixReplayCount = 0;
    if (cached) {
      ctx.onLog?.(
        "info",
        `cache hit · replaying ${cached.steps.length} step(s) without upstream calls`,
      );
      run = cached;
    } else {
      const stepOutputFixtures: Record<string, unknown> = {};
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as { id?: unknown; kind?: unknown };
        if (!step || typeof step.id !== "string") break;
        if (!isStepKindCacheable(step.kind, step)) break;
        const prefixHash = buildStepPrefixHash({
          tenant_id: ctx.tenant_id,
          execution_mode: effectiveEnvironment,
          draft: { steps, ...(draft.name ? { name: draft.name } : {}) },
          input: previewInput ?? null,
          stepIndex: i,
        });
        const fixture = readStepFixture(prefixHash);
        if (fixture === null) break;
        stepOutputFixtures[step.id] = fixture;
        prefixReplayCount++;
      }
      if (prefixReplayCount > 0) {
        ctx.onLog?.(
          "info",
          `prefix cache hit · replaying ${prefixReplayCount} upstream step(s) from fixture`,
        );
      }
      try {
        run = await runExecution({
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          source: {
            kind: "draft",
            definition,
            ...(draft.name ? { name: draft.name } : {}),
          },
          input: previewInput ?? null,
          options: {
            request_source: "chat",
            execution_mode: effectiveEnvironment,
            hold_writes: true,
            ...(signal ? { signal } : {}),
            ...(prefixReplayCount > 0 ? { step_output_fixtures: stepOutputFixtures } : {}),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const reason = (err as { code?: string }).code ?? "draft_run_failed";
        return {
          ok: false,
          error_code: reason,
          message: msg,
          data: {
            error: msg,
            reason,
          },
        };
      }
      writeDryRunCache(cacheKey, run);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as { id?: unknown; kind?: unknown };
        if (!step || typeof step.id !== "string") continue;
        if (!isStepKindCacheable(step.kind, step)) continue;
        const summary = run.steps.find((s) => s.step_key === step.id);
        if (
          summary?.status !== "succeeded" ||
          summary.held === true ||
          summary.output_preview == null
        ) {
          continue;
        }
        const envelope: Record<string, unknown> = {
          data: summary.output_preview,
          duration_ms: summary.duration_ms ?? 0,
          error: summary.error ?? null,
        };
        const rm = (summary.request_meta ?? null) as {
          status?: unknown;
          headers?: unknown;
        } | null;
        if (rm) {
          if (typeof rm.status === "number") envelope.status_code = rm.status;
          if (rm.headers && typeof rm.headers === "object") {
            envelope.headers = rm.headers as Record<string, string>;
          }
        }
        const prefixHash = buildStepPrefixHash({
          tenant_id: ctx.tenant_id,
          execution_mode: effectiveEnvironment,
          draft: { steps, ...(draft.name ? { name: draft.name } : {}) },
          input: previewInput ?? null,
          stepIndex: i,
        });
        writeStepFixture(prefixHash, envelope);
      }
    }

    const previewScope: Record<string, unknown> = {};
    for (const s of run.steps) {
      if (s.status === "succeeded" && s.output_preview !== undefined) {
        const rm = (s.request_meta ?? null) as { status?: unknown; headers?: unknown } | null;
        previewScope[s.step_key] = {
          data: s.output_preview,
          duration_ms: s.duration_ms ?? 0,
          error: null,
          ...(rm && typeof rm.status === "number" ? { status_code: rm.status } : {}),
          ...(rm?.headers && typeof rm.headers === "object"
            ? { headers: rm.headers as Record<string, string> }
            : {}),
        };
      }
    }
    if (Object.keys(previewScope).length > 0) {
      recordLastPreview({
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        scope: previewScope,
        input: previewInput ?? null,
      });
    }

    for (const step of run.steps) {
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

    const lastStepSummary = run.steps[run.steps.length - 1];
    const stoppedStep =
      run.steps.find((s) => s.status === "failed") ??
      run.steps.find((s) => s.status !== "succeeded") ??
      null;
    const stoppedId = stoppedStep?.step_key ?? null;
    const stoppedError =
      stoppedStep?.status === "failed" && stoppedStep.error && typeof stoppedStep.error === "object"
        ? (stoppedStep.error as { message?: unknown }).message
        : null;
    const stoppedMessage = typeof stoppedError === "string" ? stoppedError : null;

    const fallbackStep = steps[steps.length - 1];
    const matchedStep = lastStepSummary
      ? (steps.find((s) => s.id === lastStepSummary.step_key) ?? fallbackStep)
      : undefined;
    const lastStep: PreviewStepSummary | undefined =
      lastStepSummary && matchedStep ? classifyRunResult(matchedStep, run) : undefined;

    const finalOutputForLlm =
      run.output !== undefined && run.output !== null
        ? truncateStepPreviewForLlm(run.output)
        : null;
    const finalOutputField = finalOutputForLlm
      ? {
          final_output: finalOutputForLlm.data,
          ...(finalOutputForLlm.raw_ref ? { final_output_ref: finalOutputForLlm.raw_ref } : {}),
        }
      : {};

    const stepResultsField = args.include_step_results
      ? { step_results: buildRawStepResults(run.steps) }
      : {};

    const stoppedForDraft = stoppedId ?? lastStep?.step_id ?? "(end)";
    const unverifiedBoundaryNotice = unverifiedBoundaries(steps, run.steps);
    const unverifiedBoundariesField = unverifiedBoundaryNotice
      ? { unverified_boundaries: unverifiedBoundaryNotice }
      : {};
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? null,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
    runWarnings.push(...authorPermissionWarnings);
    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "workflow" });
    if (runWarnings.length > 0) {
      recordExecutionWarningsEmitted({
        tenant_id: ctx.tenant_id,
        step_kind: "workflow",
        count: runWarnings.length,
      });
    }
    const repairWarnings = runWarnings.filter(
      (w) =>
        w.code === "unresolved_identifier" ||
        w.code === "transform_empty_extraction" ||
        w.code === "loop_over_unresolved" ||
        w.code === "loop_body_empty" ||
        w.code === "output_contract_violation",
    );
    const dryRunRequiresRepair = repairWarnings.length > 0;

    runWarnings.push(...computeScopeDriftWarnings(ctx.getDraft(), run.steps));

    const dryRunGreen = run.status === "succeeded" && !dryRunRequiresRepair;
    let judgeOutcome: PreviewJudgeOutcome | null = null;
    let judgeBlocked = false;
    let nextJudgeBreaker: JudgeBreakerState | undefined;
    let judgeDoneSignal: Awaited<ReturnType<typeof runPreviewJudgeGate>>["doneSignal"] = null;
    let judgeEscalate = false;
    if (dryRunGreen) {
      const gate = await runPreviewJudgeGate({
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        db: ctx.db,
        goal: typeof draft.goal === "string" && draft.goal.trim().length > 0 ? draft.goal : null,
        definition,
        steps: steps as unknown as Array<Record<string, unknown>>,
        run_steps: run.steps,
        final_output: run.output,
        prior_breaker: ctx.getDraft().state?.judge_breaker ?? null,
        ...(signal ? { signal } : {}),
      });
      judgeOutcome = gate.judgeOutcome;
      judgeBlocked = gate.judgeBlocked;
      nextJudgeBreaker = gate.nextJudgeBreaker;
      judgeDoneSignal = gate.doneSignal;
      judgeEscalate = gate.escalate === true;
      if (gate.warning) runWarnings.push(gate.warning);
    }

    const persistedStepTracesUnstamped = run.steps.map((s) => {
      const errorCode =
        s.error && typeof s.error === "object" && s.error !== null
          ? (s.error as { code?: unknown }).code
          : undefined;
      const scope =
        s.output_preview !== undefined && s.output_preview !== null
          ? buildScopeAtStep(s.output_preview)
          : undefined;
      const persistedPreview =
        s.output_preview !== undefined && s.output_preview !== null
          ? truncateStepPreviewForLlm(s.output_preview).data
          : undefined;
      const persistedRawPreview =
        s.raw_preview !== undefined && s.raw_preview !== null
          ? truncateStepPreviewForLlm(s.raw_preview).data
          : undefined;
      return {
        step_id: s.step_key,
        kind: s.kind,
        status: s.status,
        ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
        ...(persistedPreview !== undefined ? { output_preview: persistedPreview } : {}),
        ...(persistedRawPreview !== undefined ? { raw_preview: persistedRawPreview } : {}),
        ...(scope ? { scope_at_step: scope } : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
        ...(s.held
          ? { held: true, held_request: truncateStepPreviewForLlm(s.held_request).data }
          : {}),
      };
    });
    const persistedStepTraces = stampStepTraceFingerprints(
      persistedStepTracesUnstamped,
      steps as unknown as Array<Record<string, unknown>>,
    );

    const draftForPreview =
      nextJudgeBreaker !== undefined
        ? withJudgeBreaker(ctx.getDraft(), nextJudgeBreaker)
        : ctx.getDraft();
    const nextDraft = withLatestPreview(
      draftForPreview,
      {
        ok: run.status === "succeeded",
        step_id: stoppedForDraft,
        summary: lastStep?.summary ?? `Run completed with status ${run.status}.`,
        preview: finalOutputForLlm?.data ?? lastStep?.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(dryRunRequiresRepair || judgeBlocked ? { requires_repair: true } : {}),
        step_traces: persistedStepTraces,
        input: previewInput ?? null,
      },
      "dry_run_workflow",
      "workflow_previewed",
    );
    await ctx.setDraft(nextDraft);

    const stepTrace = run.steps.map((s) => {
      const errorCode =
        s.error && typeof s.error === "object" && s.error !== null
          ? (s.error as { code?: unknown }).code
          : undefined;
      const scope =
        s.output_preview !== undefined && s.output_preview !== null
          ? buildScopeAtStep(s.output_preview)
          : null;
      const previewForLlm =
        s.output_preview !== undefined && s.output_preview !== null
          ? truncateStepPreviewForLlm(s.output_preview)
          : null;
      const rawForLlm =
        s.raw_preview !== undefined && s.raw_preview !== null
          ? truncateStepPreviewForLlm(s.raw_preview)
          : null;
      return {
        step_id: s.step_key,
        kind: s.kind,
        status: s.status,
        ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
        ...(s.request_meta !== undefined && s.request_meta !== null
          ? { request_meta: s.request_meta }
          : {}),
        ...(previewForLlm
          ? {
              output_preview: previewForLlm.data,
              ...(previewForLlm.raw_ref ? { output_preview_ref: previewForLlm.raw_ref } : {}),
            }
          : {}),
        ...(rawForLlm
          ? {
              raw_preview: rawForLlm.data,
              ...(rawForLlm.raw_ref ? { raw_preview_ref: rawForLlm.raw_ref } : {}),
            }
          : {}),
        ...(scope ? { scope_at_step: scope } : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
        ...(s.error ? { error: s.error } : {}),
      };
    });

    const warningsBanner =
      runWarnings.length > 0
        ? {
            count: runWarnings.length,
            codes: Array.from(new Set(runWarnings.map((w) => w.code))).sort(),
            summary: `${runWarnings.length} warning(s): ${Array.from(
              new Set(runWarnings.map((w) => w.code)),
            )
              .sort()
              .join(", ")}`,
            entries: runWarnings,
          }
        : null;

    const judgeSkipped = judgeOutcome?.verdict === "skipped";
    const autoCommitAllowed = ctx.permission_mode === "auto";
    const wouldReplacePersisted = replacesPersistedWorkflow(ctx.getDraft().summary);
    const autoUnjudgedCommit = autoCommitAllowed && !wouldReplacePersisted;
    const cleanPreview =
      dryRunGreen && !judgeBlocked && autoCommitAllowed && (!judgeSkipped || autoUnjudgedCommit);
    const greenPendingSave = dryRunGreen && !judgeBlocked && !cleanPreview;
    const judgeExhausted = judgeBlocked && judgeDoneSignal != null;
    const previewNextActions =
      cleanPreview || greenPendingSave
        ? ["save_workflow_draft"]
        : judgeEscalate
          ? ["save_workflow_draft"]
          : judgeExhausted
            ? ["save_workflow_draft", "edit_workflow_patch"]
            : judgeBlocked
              ? ["edit_workflow_patch", "inspect_workflow_draft", "dry_run_workflow"]
              : dryRunRequiresRepair
                ? ["diagnose_latest_execution", "edit_workflow_patch", "inspect_workflow_draft"]
                : ["inspect_workflow_draft", "edit_workflow_patch"];
    const previewNextPrompt = cleanPreview
      ? "Committing the workflow"
      : greenPendingSave
        ? judgeSkipped
          ? wouldReplacePersisted
            ? "Preview is green, but no goal was set, so nothing judged it against one — and committing would REPLACE an existing persisted workflow. Not auto-committed. Tell the user which workflow would be replaced and let them decide, then call save_workflow_draft."
            : "Preview is green — call save_workflow_draft to persist it (the preview was not judged, so it is not auto-committed)"
          : "Preview is green and judged. Call save_workflow_draft so the normal human approval gate decides whether to persist it."
        : judgeExhausted
          ? (judgeDoneSignal?.guidance ??
            "The preview still does not satisfy the goal and was NOT committed — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft")
          : judgeBlocked
            ? "Revise the workflow so the preview satisfies the goal (edit_workflow_patch), then re-run dry_run_workflow"
            : dryRunRequiresRepair
              ? "Open diagnosis to see why the preview needs repair"
              : `Re-run preview after fixing step \`${stoppedForDraft}\``;
    const warningSummary = runWarnings.length > 0 ? (warningsBanner?.summary ?? null) : null;

    if (cleanPreview) {
      const commitResult = await commitWorkflowAtomic({
        ctx,
        skipPriorApprovalCheck: true,
        reason: "auto_persist_on_green_dry_run",
        emitAutoPersistAudit: true,
        commitIntentKind: "save_workflow_draft",
        ...(judgeOutcome
          ? {
              extraAuditMetadata: {
                judge_verdict: judgeOutcome.verdict,
                judge_reason: judgeOutcome.reason,
              },
            }
          : {}),
      });
      if (!commitResult.ok) {
        logger.warn({
          module: "conversation_tool",
          action: "dry_run_workflow.auto_commit_failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          error_code:
            (commitResult.data as { error_code?: unknown } | undefined)?.error_code ?? null,
        });
        return commitResult;
      }
      const committed =
        typeof commitResult.data === "object" && commitResult.data !== null
          ? (commitResult.data as Record<string, unknown>)
          : {};
      const versionChanged = committed.version_changed !== false;
      const totalDryRunMs = run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
      logger.info({
        module: "conversation_tool",
        action: versionChanged
          ? "dry_run_workflow.auto_committed"
          : "dry_run_workflow.already_persisted",
        msg: versionChanged
          ? "green dry-run auto-persisted workflow inline"
          : "green dry-run matched the current workflow version",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        workflow_id:
          typeof committed.workflow_id === "string"
            ? committed.workflow_id
            : (commitResult.committed_workflow_id ?? null),
        workflow_version: typeof committed.version === "number" ? committed.version : null,
        steps_ran: run.steps.length,
        dry_run_duration_ms: totalDryRunMs,
        execution_id: run.execution_id,
        warnings_count: runWarnings.length,
      });
      return {
        ok: true,
        data: {
          ...committed,
          auto_committed: versionChanged,
          auto_commit_reason: "auto_persist_on_green_dry_run",
          ...(judgeOutcome ? { judge: judgeOutcome } : {}),
          ...(judgeDoneSignal
            ? {
                judge_done: {
                  committed_as_is: true,
                  attempts: judgeDoneSignal.attempts,
                  missing: judgeDoneSignal.missing,
                  next_action: judgeDoneSignal.guidance,
                },
              }
            : {}),
          dry_run_summary: {
            steps_ran: run.steps.length,
            duration_ms: totalDryRunMs,
            execution_id: run.execution_id,
          },
          preview_evidence: previewEvidence(run.steps),
          step_trace: stepTrace,
          ...finalOutputField,
          ...inheritedReferencesField,
          ...unverifiedBoundariesField,
          ...stepResultsField,
        },
        ...(typeof commitResult.committed_workflow_id === "string"
          ? { committed_workflow_id: commitResult.committed_workflow_id }
          : {}),
      };
    }

    if (greenPendingSave) {
      const totalDryRunMs = run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
      logger.info({
        module: "conversation_tool",
        action: "dry_run_workflow.green_pending_save",
        msg: "green dry-run not auto-persisted — awaiting explicit save",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        steps_ran: run.steps.length,
        dry_run_duration_ms: totalDryRunMs,
        execution_id: run.execution_id,
        warnings_count: runWarnings.length,
      });
      return {
        ok: true,
        data: {
          auto_committed: false,
          save_required: true,
          next_best_actions: previewNextActions,
          next_prompt: previewNextPrompt,
          ...(judgeOutcome ? { judge: judgeOutcome } : {}),
          dry_run_summary: {
            steps_ran: run.steps.length,
            duration_ms: totalDryRunMs,
            execution_id: run.execution_id,
          },
          preview_evidence: previewEvidence(run.steps),
          step_trace: stepTrace,
          ...finalOutputField,
          ...inheritedReferencesField,
          ...unverifiedBoundariesField,
          ...stepResultsField,
        },
      };
    }

    const repairProposals = await proposeDryRunRepairs({
      steps,
      runWarnings,
      runError: run.error ?? null,
      output_transform: draft.output_transform,
      previewScope,
      input: previewInput ?? null,
      tenant_id: ctx.tenant_id,
      db: ctx.db,
      ...(signal ? { signal } : {}),
    });
    const repairCount = repairWarnings.length;
    const failedStepErrorCode =
      run.status !== "succeeded"
        ? (run.steps.find((s) => s.status !== "succeeded")?.error as { code?: string } | undefined)
            ?.code
        : undefined;
    const previewErrorCode = judgeEscalate
      ? "preview_judge_exhausted"
      : judgeBlocked
        ? "preview_judge_failed"
        : run.status !== "succeeded"
          ? failedStepErrorCode
            ? `draft_step_failed:${failedStepErrorCode}`
            : "draft_step_failed"
          : "preview_needs_repair";
    const previewSummary =
      run.status !== "succeeded"
        ? `Run stopped at step \`${stoppedForDraft}\`: ${stoppedMessage ?? lastStep?.summary ?? run.error?.message ?? "unknown error"}`
        : judgeExhausted && judgeOutcome && judgeOutcome.verdict !== "skipped"
          ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} without errors, but after ${judgeDoneSignal?.attempts ?? "several"} attempts the preview still does not satisfy the user's goal (judge verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}${judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}.` : ""} It was NOT committed. STOP re-running dry_run_workflow — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft.`
          : judgeBlocked && judgeOutcome && judgeOutcome.verdict !== "skipped"
            ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} without errors, but the preview does not satisfy the user's goal (judge verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}${judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}.` : ""} Fix via edit_workflow_patch and re-run dry_run_workflow — or, after the user explicitly confirms, commit anyway via save_workflow_draft.`
            : `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"}, but the preview needs repair — ${repairCount} blocking warning${repairCount === 1 ? "" : "s"}. Fix the flagged step before committing.`;
    const heldStepCount = run.steps.filter((s) => s.held).length;
    const skippedDependentCount = run.steps.filter(
      (s) => (s.error as { code?: string } | undefined)?.code === "skipped_dependency_held",
    ).length;
    const heldReadHint =
      heldStepCount > 0 && skippedDependentCount > 0
        ? `${heldStepCount} step(s) were HELD as writes and ${skippedDependentCount} dependent step(s) were skipped, so the preview could not produce a complete result. Only a verified read-only HTTP POST search endpoint supports the \`side_effects: "read"\` override. This label cannot authorize SQL writes, GraphQL mutations, or remote MCP tool calls. Keep those effects held, or request explicit approval for a live write run.`
        : null;
    const previewMessage = heldReadHint ? `${previewSummary} ${heldReadHint}` : previewSummary;
    return {
      ok: cleanPreview,
      ...(cleanPreview ? {} : { error_code: previewErrorCode, message: previewMessage }),
      data: buildLifecyclePayload(
        nextDraft,
        {
          steps_ran: run.steps.length,
          duration_ms: run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0),
          classification:
            dryRunRequiresRepair || judgeBlocked
              ? "needs_repair"
              : (lastStep?.classification ?? (run.status === "succeeded" ? "ok" : "driver_error")),
          stopped_at_step_id: stoppedId,
          summary: previewSummary,
          ...(heldReadHint ? { held_read_hint: heldReadHint } : {}),
          execution_id: run.execution_id,
          next_best_actions: previewNextActions,
          next_prompt: previewNextPrompt,
          ...(judgeOutcome ? { judge: judgeOutcome } : {}),
          ...(judgeDoneSignal
            ? {
                judge_done: {
                  committed_as_is: false,
                  escalate: judgeEscalate,
                  attempts: judgeDoneSignal.attempts,
                  missing: judgeDoneSignal.missing,
                  next_action: judgeDoneSignal.guidance,
                },
              }
            : {}),
          ...(warningSummary ? { warning_summary: warningSummary } : {}),
          ...(warningsBanner ? { warnings_banner: warningsBanner } : {}),
          ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
          ...(repairProposals.length > 0 ? { repair_proposals: repairProposals } : {}),
          preview_evidence: previewEvidence(run.steps),
          step_trace: stepTrace,
          ...finalOutputField,
          ...inheritedReferencesField,
          ...unverifiedBoundariesField,
          ...stepResultsField,
          ...(lastStep
            ? (() => {
                const lastPreviewForLlm =
                  lastStep.output_preview !== undefined && lastStep.output_preview !== null
                    ? truncateStepPreviewForLlm(lastStep.output_preview)
                    : null;
                return {
                  last_step: {
                    step_id: lastStep.step_id,
                    kind: lastStep.kind,
                    classification: lastStep.classification,
                    duration_ms: lastStep.duration_ms,
                    ...(lastPreviewForLlm
                      ? {
                          output_preview: lastPreviewForLlm.data,
                          ...(lastPreviewForLlm.raw_ref
                            ? { output_preview_ref: lastPreviewForLlm.raw_ref }
                            : {}),
                        }
                      : {}),
                    ...(lastStep.error ? { error: lastStep.error } : {}),
                  },
                };
              })()
            : {}),
        },
        { readOnly: true },
      ),
    };
  },
};
