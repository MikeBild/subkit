// dry_run_workflow — run the draft workflow end-to-end via runExecution
// with source.kind="draft". No persistence of a workflow row is needed;
// the engine synthesizes workflow_id internally but keeps the executions
// row's workflow_id column NULL so it's clearly separable from saved runs.

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
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { buildScopeAtStep } from "../../workflows/scope-shape.ts";
import type { StepDef } from "../../workflows/types.ts";
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
import { resolveConversationPrincipal } from "./call-connector.ts";
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
import { recordLastPreview } from "./last-preview-store.ts";
import { truncateStepPreviewForLlm } from "./truncate.ts";

const inputSchema = z
  .object({
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
    execute_writes: z
      .boolean()
      .optional()
      .describe(
        `Execute write-classified steps for real instead of holding them. Default false: previews resolve writes (URL/headers/body materialized for inspection and the judge) but never dispatch them. Set true ONLY when the user explicitly confirmed a live preview.`,
      ),
  })
  .openapi("DryRunWorkflowToolInput");

export const dryRunWorkflowTool: ConversationTool = {
  name: "dry_run_workflow",
  description:
    "Run the entire draft workflow via runExecution (source=draft). Produces an executions row with source_kind=draft, no workflow_id / workflow_version_id persisted. Read steps execute for real; WRITE steps (sends, publishes, mutations) are HELD by default — fully resolved (URL/headers/body materialized as the step artifact) but never dispatched, so previews cannot publish. Pass execute_writes: true only after the user explicitly confirmed a live preview. External destinations (recipients, channels, webhook URLs) must come from the user, never fabricated placeholders.",
  inputSchema,
  category: "draft_write" as const,
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

    // Cycle pre-flight — refuse to dry-run a workflow with a cyclic
    // step dependency. The runtime walker would silently produce
    // undefined values for the steps stuck behind the cycle, then
    // mask the bug as a transform_empty_extraction warning. Surface
    // the typed cycle error instead so the operator can fix it.
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
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              cycles: cycleReport.cycles,
            },
          }),
        };
      }
    }

    // Reference pre-flight — refuse to dry-run a workflow that points
    // a JSONata expression or `${scope.X}` placeholder at a step id
    // that doesn't exist. The runtime would otherwise resolve the bad
    // reference to undefined and emit `loop_over_unresolved` /
    // `transform_empty_extraction` warnings — the user has to read
    // the warnings, then map them back to the bad reference. Surface
    // the typed error directly with `did_you_mean` candidates so the
    // operator can fix the typo without burning a dry-run cycle.
    // Unsupported-placeholder pre-flight — Mustache `{{...}}`,
    // `${$loop...}`, `${user.X}` etc. would ship verbatim through the
    // driver and 404 upstream. Reject with a concrete `did_you_mean`
    // rewrite instead of burning a dry-run cycle on a doomed request.
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
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              unsupported_placeholders: placeholderErrors,
            },
          }),
        };
      }
    }

    {
      const refErrors = validateStepReferences({ name: draft.name ?? "draft", steps });
      if (refErrors.length > 0) {
        const summary = refErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field} → unknown step \`${e.bad_reference}\`` +
              (e.did_you_mean.length > 0
                ? ` (did you mean: ${e.did_you_mean.map((s) => `\`${s}\``).join(", ")})`
                : ""),
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unresolved_step_reference",
          tool: "dry_run_workflow",
        });
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "workflow_unresolved_step_reference",
            message: `workflow has unresolved step references: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param", "edit_workflow_patch"],
            extra: {
              unresolved_references: refErrors,
            },
          }),
        };
      }
    }

    // Author build-time permission pre-flight (Stream 4) — best-effort,
    // non-blocking. Computed on the static draft; merged into the surfaced
    // `warnings` below so the author learns at authoring time that a write
    // step targets a connector they cannot write, instead of failing live.
    const author = await resolveConversationPrincipal(ctx);
    const authorPermissionWarnings = author
      ? await authorConnectorWriteWarnings(
          ctx.db,
          author,
          ctx.tenant_id,
          steps as unknown as Array<Record<string, unknown>>,
        )
      : [];

    // Circuit-breaker — same as run-workflow. Three consecutive
    // dry-runs producing the same authoring-bug warning code mean the
    // LLM's strategy isn't converging. Halt and force the LLM to ask
    // or re-strategize instead of running again. Codes that count:
    // `unresolved_identifier`, `loop_over_unresolved`,
    // `transform_empty_extraction`. Each one means the JSONata path
    // doesn't actually resolve to data the engine can use, so a
    // re-run with no other changes will produce the same warning.
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
              "propose_step",
            ],
            extra: { tripped_codes: trippedCodes },
          }),
        };
      }
    } catch (err) {
      // DB blip: don't trip the breaker on a query failure, but log
      // it so a recurring outage shows up in operator triage rather
      // than silently disabling the repair-loop guard.
      logger.warn({
        module: "conversation_tool",
        action: "dry_run_workflow.repair_loop_query_failed",
        msg: "repair-loop history query failed; circuit-breaker check skipped this turn",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // The draft's workflow-level output surface travels with the
    // definition (Fix 11): `output_transform` shapes the final payload
    // exactly like a live run would, and `output_schema` makes the
    // engine validate that payload against the declared contract. The
    // resulting `output_contract_violation` warning is BLOCKING here
    // (see repairWarnings below) — a draft that does not produce the
    // contracted shape never auto-commits.
    const definition = {
      name: draft.name ?? "draft",
      steps,
      ...(typeof draft.output_transform === "string" && draft.output_transform.length > 0
        ? { output_transform: draft.output_transform }
        : {}),
      ...(draft.output_schema ? { output_schema: draft.output_schema } : {}),
    };
    const signal = ctx.abortSignal;

    // Resolve the effective execution environment (dev vs prod credential
    // grant) for the draft's connectors. See resolveDryRunEnvironment.
    const effectiveEnvironment = await resolveDryRunEnvironment({
      tenant_id: ctx.tenant_id,
      steps,
      requested: args.environment,
      exec: ctx.db,
      conversation_id: ctx.conversation_id,
      onLog: ctx.onLog,
    });

    ctx.onLog?.(
      "info",
      `dry-running ${steps.length} step${steps.length === 1 ? "" : "s"} (env=${effectiveEnvironment})`,
    );
    // Cache hit short-circuit. Pre-fix re-previewing an unchanged draft
    // re-ran every step end-to-end (109 calls to api.digitalocean.com
    // for the f00b8d1c session). Hash the draft + input; if a recent
    // success exists, replay the cached envelope instead of hitting
    // the upstream again.
    const cacheKey = buildDryRunCacheKey({
      tenant_id: ctx.tenant_id,
      execution_mode: effectiveEnvironment,
      draft: definition,
      input: args.input ?? null,
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
      // Per-step prefix fixtures. Walk the draft from the top while
      // each step's prefix hash matches a cached envelope; feed those
      // envelopes into runExecution via `step_output_fixtures` so the
      // engine skips re-executing them. The first miss stops the
      // prefix walk — downstream steps execute normally and their
      // envelopes get written back to the prefix cache on success.
      const stepOutputFixtures: Record<string, unknown> = {};
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as { id?: unknown; kind?: unknown };
        if (!step || typeof step.id !== "string") break;
        if (!isStepKindCacheable(step.kind, step)) break;
        const prefixHash = buildStepPrefixHash({
          tenant_id: ctx.tenant_id,
          execution_mode: effectiveEnvironment,
          draft: { steps, ...(draft.name ? { name: draft.name } : {}) },
          input: args.input ?? null,
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
          input: args.input ?? null,
          options: {
            request_source: "chat",
            execution_mode: effectiveEnvironment,
            // Previews are side-effect-safe by default: write-classified
            // steps are fully resolved (the judge reads the would-be
            // payload) but never dispatched. `execute_writes: true` is
            // the explicit full-live escape for shapes that genuinely
            // need the write's response recorded.
            hold_writes: !args.execute_writes,
            ...(signal ? { signal } : {}),
            ...(prefixReplayCount > 0 ? { step_output_fixtures: stepOutputFixtures } : {}),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const reason = (err as { code?: string }).code ?? "draft_run_failed";
        // Top-level error_code/message so `summarizeToolFailure` lifts the WHY
        // into the tool.failed log AND the error_code-repeat breaker can track
        // a draft that keeps throwing the same way (it reads top-level
        // error_code/message, not nested data).
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
      // Write back per-step envelopes for the next iteration. We only
      // cache successful steps that are kind-safe; failures bypass so
      // the next edit doesn't replay a broken result. The cached value
      // is a reconstructed `ScopeEnvelope` ({ data, duration_ms, error,
      // status_code?, headers? }) — the same shape `envelopeFor`
      // produces internally — so the engine can write it into `scope`
      // verbatim on a future fixture hit and downstream `$scope.<id>.
      // data` keeps working.
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as { id?: unknown; kind?: unknown };
        if (!step || typeof step.id !== "string") continue;
        if (!isStepKindCacheable(step.kind, step)) continue;
        const summary = run.steps.find((s) => s.step_key === step.id);
        // `held === true` guard: a write-classified GET/HEAD is held yet
        // kind-cacheable — caching its {data: null} envelope would replay
        // a null "response" as if real on the next preview. `== null`
        // also rejects null previews generally (held output is null,
        // not undefined).
        if (
          !summary ||
          summary.status !== "succeeded" ||
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
          input: args.input ?? null,
          stepIndex: i,
        });
        writeStepFixture(prefixHash, envelope);
      }
    }

    // Stash this preview's scope on the per-conversation slot so
    // `dry_run_transform` can resolve `$scope.<step_id>` references
    // without re-running the upstream. The store keeps only the
    // succeeded-step envelopes — failed steps would just confuse a
    // JSONata-only iteration loop.
    //
    // Execution parity: the runtime scope addresses every step
    // through the documented envelope — `$scope.<id>.data` is the
    // payload, `$scope.<id>.status_code` the diagnostics. A store that
    // keeps the RAW `output_preview` (no `data` wrapper) breaks this: the
    // exact expression that works in a transform step returns `{}`
    // here and the model concludes "scope doesn't work" (session
    // 784c1b02, ~10 wasted rewrite rounds). Wrap to the same envelope
    // the engine writes into `scope` (`engine/envelope.ts`).
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
        input: args.input ?? null,
      });
    }

    // Per-step progress feed — same as run_workflow. Lets the user see
    // each step's status, kind, and duration in real time instead of a
    // single end-of-preview badge.
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
    const stoppedStep = run.steps.find((s) => s.status !== "succeeded") ?? null;
    const stoppedId = stoppedStep?.step_key ?? null;

    const fallbackStep = steps[steps.length - 1];
    const matchedStep = lastStepSummary
      ? (steps.find((s) => s.id === lastStepSummary.step_key) ?? fallbackStep)
      : undefined;
    const lastStep: PreviewStepSummary | undefined =
      lastStepSummary && matchedStep ? classifyRunResult(matchedStep, run) : undefined;

    // The workflow's RESOLVED final output (post output_transform /
    // response_filters) — what the caller actually receives. The preview must
    // surface THIS, not the last step: with an output_transform the two differ,
    // and a user/judge/benchmark inspecting the last step would see the wrong
    // thing (a markdown table rendered in a step that the transform discards).
    // `null` for a hold-writes preview where no real final output exists → fall
    // back to the last step's output for the preview field.
    const finalOutputForLlm =
      run.output !== undefined && run.output !== null
        ? truncateStepPreviewForLlm(run.output)
        : null;
    // The response field carrying that final output to the model/user — same
    // truncation discipline as every other LLM-visible preview. Spread into
    // each success/blocked envelope so the caller always sees the actual
    // result, not just the last step.
    const finalOutputField = finalOutputForLlm
      ? {
          final_output: finalOutputForLlm.data,
          ...(finalOutputForLlm.raw_ref ? { final_output_ref: finalOutputForLlm.raw_ref } : {}),
        }
      : {};

    const stoppedForDraft = stoppedId ?? lastStep?.step_id ?? "(end)";
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? null,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
    // Author build-time permission warnings (Stream 4), surfaced alongside
    // the runtime warnings.
    runWarnings.push(...authorPermissionWarnings);
    recordExecutionDryRun({ tenant_id: ctx.tenant_id, source_kind: "workflow" });
    if (runWarnings.length > 0) {
      recordExecutionWarningsEmitted({
        tenant_id: ctx.tenant_id,
        step_kind: "workflow",
        count: runWarnings.length,
      });
    }
    // Mirror run-workflow's requires_repair derivation so the
    // commit-workflow gate can see that a fresher dry-run has cleared
    // (or kept) the repair flag. Only the warnings that ALWAYS
    // indicate a real bug contribute — `transform_dropped_fields`
    // alone is informational.
    // `output_contract_violation` is non-blocking on LIVE runs but
    // blocking on previews (Fix 11): a draft whose final output does
    // not satisfy its declared `output_schema` has not converged, so
    // the preview must not read green and must not auto-commit.
    const repairWarnings = runWarnings.filter(
      (w) =>
        w.code === "unresolved_identifier" ||
        w.code === "transform_empty_extraction" ||
        w.code === "loop_over_unresolved" ||
        w.code === "loop_body_empty" ||
        w.code === "output_contract_violation",
    );
    const dryRunRequiresRepair = repairWarnings.length > 0;

    // authoring_scope_changed — see scope-drift.ts (paths disappearing
    // between previews get a non-fatal warning before the LLM patches
    // downstream transforms against the new shape).
    runWarnings.push(...computeScopeDriftWarnings(ctx.getDraft(), run.steps));

    // Instruction-grounded preview judge (Fix C) — see preview-judge-gate.ts
    // for the gate + circuit-breaker semantics.
    const dryRunGreen = run.status === "succeeded" && !dryRunRequiresRepair;
    let judgeOutcome: PreviewJudgeOutcome | null = null;
    let judgeBlocked = false;
    /** undefined = leave the stored breaker untouched. */
    let nextJudgeBreaker: JudgeBreakerState | undefined;
    /** Terminal done-signal (P3) — set when the judge blocked at/over the
     *  cap and degraded to advisory; the model gets an EXIT, not another
     *  silent requires_repair. */
    let judgeDoneSignal: Awaited<ReturnType<typeof runPreviewJudgeGate>>["doneSignal"] = null;
    /** Forced operator-choice escalation: the model re-ran past the hold cap. */
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
        // The resolved final output (post output_transform) — the judge's
        // format check evaluates THIS, not intermediate steps. A markdown
        // table rendered in a middle step that output_transform discards must
        // not satisfy a "return a markdown table" goal.
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

    // Build the persisted per-step trace. The conversation context-
    // assembler reads this off `latest_preview.step_traces` on every
    // authoring turn so the LLM sees the most recent shape per step
    // without re-reading the dry_run envelope. We materialise a
    // compact view here (drop request_meta from the persisted
    // version — it's cheap to keep around in the response envelope
    // but not worth the token cost on every turn).
    // Fingerprint stamping: each persisted trace carries the
    // identity of the step definition it was recorded against, so
    // mutations drop evidence per changed step instead of wholesale and
    // the authoring gates can verify the evidence is still current.
    const persistedStepTracesUnstamped = run.steps.map((s) => {
      const errorCode =
        s.error && typeof s.error === "object" && s.error !== null
          ? (s.error as { code?: unknown }).code
          : undefined;
      // `scope_at_step` (enumerated JSONata paths + shape summary) is the
      // authoring-critical projection and is computed from the FULL preview
      // here, BEFORE the preview itself is capped below. So capping the
      // persisted `output_preview` / `raw_preview` loses no path/shape signal
      // the next turn relies on.
      const scope =
        s.output_preview !== undefined && s.output_preview !== null
          ? buildScopeAtStep(s.output_preview)
          : undefined;
      // Cap the persisted previews to the same per-step budget the LLM
      // envelope uses. `latest_preview.step_traces` is persisted into
      // `conversations.draft` (JSONB) and re-rendered into the authoring
      // prompt on EVERY turn; storing a step's full ~10 KB preview × N steps
      // ballooned the draft to multi-MB and drove the per-turn heap into the
      // memory-pressure band. The full payload remains in the execution step
      // rows (reachable via inspect_execution_step / diagnose_latest_execution),
      // so this only trims the redundant in-draft copy. `.data` is the
      // structurally-truncated shape (keys/sample values preserved).
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
        // Hold-writes preview: the materialized-but-never-dispatched
        // request IS the step's reviewable artifact — the model (and
        // the user) inspect the would-be send without anything firing.
        ...(s.held
          ? { held: true, held_request: truncateStepPreviewForLlm(s.held_request).data }
          : {}),
      };
    });
    const persistedStepTraces = stampStepTraceFingerprints(
      persistedStepTracesUnstamped,
      steps as unknown as Array<Record<string, unknown>>,
    );

    // A judge block writes the breaker counter into the draft state in
    // the same persist as the preview itself — one setDraft, no torn
    // state between the verdict and its anti-churn bookkeeping.
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
        // Prefer the resolved final output (post output_transform) — that is
        // what the caller receives and what the judge now evaluates.
        preview: finalOutputForLlm?.data ?? lastStep?.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        // A judge block joins the requires_repair path so its blocking
        // semantics (no auto-commit; explicit save / force_commit stays
        // available) match the structural repair warnings exactly.
        ...(dryRunRequiresRepair || judgeBlocked ? { requires_repair: true } : {}),
        step_traces: persistedStepTraces,
        input: args.input ?? null,
      },
      "dry_run_workflow",
      "workflow_previewed",
    );
    await ctx.setDraft(nextDraft);

    // Per-step trace — surface every step's actual output shape +
    // request_meta on the dry_run response so the LLM can author
    // downstream transforms against REAL scope shapes instead of
    // guessing at JSONata paths. Pre-fix the LLM in session 3f6082d2
    // wrote format_output blind, the projection silently dropped the
    // loop body's resources field, and v1→v2→v3 of the workflow
    // committed without ever seeing the canonical shape. Each entry
    // is truncated to ~1KB by the runtime's offload layer
    // (output_preview is already capped); the LLM sees enough shape
    // to author the next transform without burning the whole context.
    //
    // Gives the LLM a single
    // structured trace it can scan to pinpoint the failing step plus
    // its driver-level metadata (status code, byte counts, connector
    // resolution).
    const stepTrace = run.steps.map((s) => {
      const errorCode =
        s.error && typeof s.error === "object" && s.error !== null
          ? (s.error as { code?: unknown }).code
          : undefined;
      // scope_at_step is the authoring-vocab projection of the
      // step's actual output shape (available_paths + shape_summary
      // + primary_data_path). Computed once here so both the
      // returned envelope and the persisted `step_traces` slot share
      // the exact same shape — no drift between what the LLM saw on
      // dry_run and what `inspect_workflow_draft` shows next turn.
      const scope =
        s.output_preview !== undefined && s.output_preview !== null
          ? buildScopeAtStep(s.output_preview)
          : null;
      // Per-step LLM-context cap. The persisted dry-run preview keeps
      // the full output_preview (next-turn `inspect_workflow_draft`
      // sees the full shape via persistedStepTraces above); only the
      // returned envelope is clipped. Restores the contract documented
      // a few lines above ("output_preview is already capped").
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

    // Banner-style warnings summary at the top of the result
    // envelope. Pre-fix the LLM had to scroll past `step_trace` and
    // dive into `data.warnings` to notice loop_over_unresolved /
    // unresolved_identifier signals (session ebd66982: the LLM
    // missed three consecutive warnings before reading them).
    // Promoting a one-line summary plus the structured list to the
    // outer envelope makes the signal unmissable on the first read.
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

    // Next-action hint on the dry-run envelope. Green preview that
    // doesn't need a repair pass → commit; otherwise → fix-it loop.
    // Pre-fix the success path was silent and the user had to type
    // "yes" twice before the LLM proposed save_workflow_draft (session
    // 0ac7593c). Even with task #4's auto-commit behaviour live, the
    // hint stays on the envelope so the chat renderer's lifecycle line
    // and the never-silent guard in loop.ts both have something to
    // anchor on.
    // a green dry-run auto-commits ONLY when the preview judge actually
    // rendered a verdict against a stashed goal. With no goal the judge is
    // skipped (`judge.no_goal`); a bare verification dry-run during iteration
    // must NOT mint a new workflow version every call (the corsica session
    // churned v6→v12 this way, six `auto_persist_on_green_dry_run` commits in
    // 36 min). A green-but-unjudged preview is still `ok` — it just returns the
    // `save_workflow_draft` next-action so the model/user persists once,
    // deliberately, when they mean to.
    const judgeSkippedNoGoal =
      judgeOutcome?.verdict === "skipped" && judgeOutcome?.reason === "no_goal";
    const cleanPreview = dryRunGreen && !judgeBlocked && !judgeSkippedNoGoal;
    const greenPendingSave = dryRunGreen && !judgeBlocked && judgeSkippedNoGoal;
    // The judge hit its block cap: the edit loop is exhausted but the preview
    // still does not satisfy the goal. Do NOT keep nudging edit→dry_run (that
    // is the loop the breaker exists to stop); instead offer an explicit
    // commit-as-is OR a final edit, and let the done-signal guidance tell the
    // model to surface the gap to the user.
    const judgeExhausted = judgeBlocked && judgeDoneSignal != null;
    const previewNextActions =
      cleanPreview || greenPendingSave
        ? ["save_workflow_draft"]
        : judgeEscalate
          ? // Forced escalation: the only tool action left is commit-as-is; the
            // model must otherwise ASK the user (a conversational, not tool, move).
            ["save_workflow_draft"]
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
        ? "Preview is green — call save_workflow_draft to persist it (no goal was set, so it is not auto-committed)"
        : judgeExhausted
          ? (judgeDoneSignal?.guidance ??
            "The preview still does not satisfy the goal and was NOT committed — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft")
          : judgeBlocked
            ? "Revise the workflow so the preview satisfies the goal (edit_workflow_patch), then re-run dry_run_workflow"
            : dryRunRequiresRepair
              ? "Open diagnosis to see why the preview needs repair"
              : `Re-run preview after fixing step \`${stoppedForDraft}\``;
    const warningSummary = runWarnings.length > 0 ? (warningsBanner?.summary ?? null) : null;

    // Auto-commit on green dry-run. A clean preview means the draft
    // is validated end-to-end against real data; persisting
    // immediately removes the redundant approval step that produced
    // the "yes" → "yes" → "commit this" loop in session 0ac7593c.
    // `skipPriorApprovalCheck: true` bypasses the ask_user_confirm
    // gate the explicit save tool requires; the audit row is tagged
    // `auto_persist_on_green_dry_run` so the history is unambiguous.
    // If the commit refuses (e.g. workflow_not_ready, slug clash) the
    // typed envelope is returned verbatim so the LLM picks the right
    // recovery move.
    if (cleanPreview) {
      const commitResult = await commitWorkflowAtomic({
        ctx,
        skipPriorApprovalCheck: true,
        reason: "auto_persist_on_green_dry_run",
        emitAutoPersistAudit: true,
        commitIntentKind: "save_workflow_draft",
        // Governance: the immutable record of WHY this auto-commit was
        // permitted carries the semantic gate's verdict alongside the
        // structural green.
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
      const totalDryRunMs = run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
      logger.info({
        module: "conversation_tool",
        action: "dry_run_workflow.auto_committed",
        msg: "green dry-run auto-persisted workflow inline",
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
          auto_committed: true,
          auto_commit_reason: "auto_persist_on_green_dry_run",
          // The judge outcome rides the commit envelope: `passes`
          // verdicts, skips (no_goal / judge_unavailable), and
          // breaker-degraded advisory verdicts are all visible here.
          ...(judgeOutcome ? { judge: judgeOutcome } : {}),
          // Terminal done-signal (P3): when a still-unsatisfied preview
          // was committed as-is because the judge hit its block cap, the
          // model gets an explicit EXIT — stop editing, tell the user
          // what's missing, ask how to proceed. Surfaced as guidance,
          // not another silent requires_repair.
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
          // Preserve the per-step trace from the dry-run on the
          // auto-committed envelope. The LLM still needs to see
          // step-by-step shape + status to author downstream
          // transforms or to debug a follow-up run.
          step_trace: stepTrace,
          ...finalOutputField,
        },
        ...(typeof commitResult.committed_workflow_id === "string"
          ? { committed_workflow_id: commitResult.committed_workflow_id }
          : {}),
      };
    }

    // Green preview, but no goal was stashed so the judge was skipped:
    // do NOT auto-persist a workflow version. Return the green result with an
    // explicit `save_workflow_draft` next-action so the model/user commits
    // once, deliberately — instead of every iteration dry-run minting a new
    // version. This is still a success envelope (the run was green); it is the
    // auto-commit that is withheld, not the preview.
    if (greenPendingSave) {
      const totalDryRunMs = run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
      logger.info({
        module: "conversation_tool",
        action: "dry_run_workflow.green_pending_save",
        msg: "green dry-run not auto-persisted — no goal stashed; awaiting explicit save",
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
          step_trace: stepTrace,
          ...finalOutputField,
        },
      };
    }

    // This return is the NOT-clean path — `cleanPreview` returned early
    // above. The run either failed outright, or it succeeded on paper
    // but a step produced broken output (an empty transform, an
    // unresolved reference). Either way the preview is not `ok`: a green
    // `run.status` must never read as success while the workflow still
    // produces broken output. Pre-fix a `transform_empty_extraction`
    // preview reported `ok:true`, `classification:"ok"`, and "Ran N
    // steps with no errors" — so the authoring agent iterated for a
    // dozen turns against a false green.
    //
    // Bounded auto-repair (Fix 10) — propose-only; see dry-run-repair.ts.
    const repairProposals = await proposeDryRunRepairs({
      steps,
      runWarnings,
      runError: run.error ?? null,
      output_transform: draft.output_transform,
      previewScope,
      input: args.input ?? null,
      tenant_id: ctx.tenant_id,
      db: ctx.db,
      ...(signal ? { signal } : {}),
    });
    const repairCount = repairWarnings.length;
    // The failing step's driver error_code (e.g. `http_4xx`), when the run
    // stopped on a step rather than on the judge — suffixed into the tool-level
    // error_code so an operator (and the error_code-repeat breaker) sees the
    // SHAPE of the failure, not just "needs repair".
    const failedStepErrorCode =
      run.status !== "succeeded"
        ? (run.steps.find((s) => s.status !== "succeeded")?.error as { code?: string } | undefined)
            ?.code
        : undefined;
    // Stable top-level error_code for the ok:false envelope. judge block,
    // step failure, or structural repair-needed — each gets a distinct code.
    const previewErrorCode = judgeEscalate
      ? "preview_judge_exhausted"
      : judgeBlocked
        ? "preview_judge_failed"
        : run.status !== "succeeded"
          ? failedStepErrorCode
            ? `draft_step_failed:${failedStepErrorCode}`
            : "draft_step_failed"
          : "preview_needs_repair";
    // Hoisted so it serves BOTH the lifecycle payload's `summary` AND the
    // top-level `message` summarizeToolFailure lifts into the tool.failed log.
    const previewSummary =
      run.status !== "succeeded"
        ? `Run stopped at step \`${stoppedForDraft}\`: ${lastStep?.summary ?? run.error?.message ?? "unknown error"}`
        : judgeExhausted && judgeOutcome && judgeOutcome.verdict !== "skipped"
          ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} without errors, but after ${judgeDoneSignal?.attempts ?? "several"} attempts the preview still does not satisfy the user's goal (judge verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}${judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}.` : ""} It was NOT committed. STOP re-running dry_run_workflow — tell the user what is missing and ask how to proceed, or commit as-is via save_workflow_draft.`
          : judgeBlocked && judgeOutcome && judgeOutcome.verdict !== "skipped"
            ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} without errors, but the preview does not satisfy the user's goal (judge verdict: ${judgeOutcome.verdict}): ${judgeOutcome.reason}${judgeOutcome.missing.length > 0 ? ` Missing: ${judgeOutcome.missing.join("; ")}.` : ""} Fix via edit_workflow_patch and re-run dry_run_workflow — or, after the user explicitly confirms, commit anyway via save_workflow_draft.`
            : `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"}, but the preview needs repair — ${repairCount} blocking warning${repairCount === 1 ? "" : "s"}. Fix the flagged step before committing.`;
    // Held-read nudge: when holding a step skipped its dependents and the
    // preview is therefore incomplete, the held step is often a READ
    // misclassified as a write (e.g. a scrape that uses POST). Surface a hint
    // to set side_effects:read so the preview executes it. Message-only — never
    // auto-reclassify, because a POST can be a genuine write. Fires ONLY when
    // holding actually broke the preview (held + skipped dependents), so a
    // legitimate held-write preview that still produces output stays quiet.
    const heldStepCount = run.steps.filter((s) => s.held).length;
    const skippedDependentCount = run.steps.filter(
      (s) => (s.error as { code?: string } | undefined)?.code === "skipped_dependency_held",
    ).length;
    const heldReadHint =
      heldStepCount > 0 && skippedDependentCount > 0
        ? `${heldStepCount} step(s) were HELD as writes and ${skippedDependentCount} dependent step(s) were skipped, so the preview could not produce a complete result. If a held step only READS data (e.g. a scrape or fetch that does not mutate state), set \`side_effects: "read"\` on it so the preview runs it instead of holding it.`
        : null;
    const previewMessage = heldReadHint ? `${previewSummary} ${heldReadHint}` : previewSummary;
    return {
      ok: cleanPreview,
      // This path is always ok:false (cleanPreview returned early). The
      // top-level error_code/message let `summarizeToolFailure` log the WHY
      // and let the error_code-repeat breaker (which reads top-level fields,
      // not nested data) track a model re-issuing the same failing preview.
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
          // Judge verdict on the blocked envelope — the model reads
          // `judge.missing` to target the repair.
          ...(judgeOutcome ? { judge: judgeOutcome } : {}),
          // Terminal done-signal on the HELD (not committed) envelope: the
          // judge exhausted its block cap and the preview still fails the goal.
          // `committed_as_is: false` is the contract that distinguishes this
          // from the legitimate auto-commit path — the model must stop the
          // edit loop and ask the user, not keep re-running dry_run_workflow.
          ...(judgeDoneSignal
            ? {
                judge_done: {
                  committed_as_is: false,
                  // `escalate: true` means the model ignored the EXIT and re-ran
                  // past the hold cap — it must now force the operator choice.
                  escalate: judgeEscalate,
                  attempts: judgeDoneSignal.attempts,
                  missing: judgeDoneSignal.missing,
                  next_action: judgeDoneSignal.guidance,
                },
              }
            : {}),
          ...(warningSummary ? { warning_summary: warningSummary } : {}),
          // Top-level banner so the LLM can't miss warnings on first
          // read. `warnings` (legacy field) stays for back-compat
          // consumers but the banner is the canonical surface.
          ...(warningsBanner ? { warnings_banner: warningsBanner } : {}),
          ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
          // Propose-only repair outcomes (Fix 10). `repaired: true`
          // entries carry a VERIFIED expression (compiles; non-empty
          // against this run's recorded scope where applicable) —
          // apply via update_param / edit_workflow_patch, then
          // re-preview. The draft was not changed.
          ...(repairProposals.length > 0 ? { repair_proposals: repairProposals } : {}),
          step_trace: stepTrace,
          ...finalOutputField,
          ...(lastStep
            ? (() => {
                // Same per-step LLM cap as the step_trace assembler
                // above. Without this, last_step.output_preview is the
                // second LLM-visible copy of the final step's full
                // output and would re-introduce the same envelope-bloat
                // path step_trace just stopped causing.
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
