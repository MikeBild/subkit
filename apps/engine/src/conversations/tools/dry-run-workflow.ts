// dry_run_workflow — run the draft workflow end-to-end via runExecution
// with source.kind="draft". No persistence of a workflow row is needed;
// the engine synthesizes workflow_id internally but keeps the executions
// row's workflow_id column NULL so it's clearly separable from saved runs.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
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
import { getWorkflowDraft, withLatestPreview } from "../authoring-state.ts";
import { buildGateError, buildLifecyclePayload } from "./authoring-contract.ts";
import { buildDryRunCacheKey, readDryRunCache, writeDryRunCache } from "./dry-run-cache.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { truncateStepPreviewForLlm } from "./truncate.ts";

const inputSchema = z
  .object({
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
  })
  .openapi("DryRunWorkflowToolInput");

export const dryRunWorkflowTool: ConversationTool = {
  name: "dry_run_workflow",
  description:
    "Run the entire draft workflow via runExecution (source=draft). Produces an executions row with source_kind=draft, no workflow_id / workflow_version_id persisted.",
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
    } catch {
      // DB blip: don't trip the breaker on a query failure.
    }

    const definition = { name: draft.name ?? "draft", steps };
    const signal = ctx.abortSignal;
    ctx.onLog?.(
      "info",
      `dry-running ${steps.length} step${steps.length === 1 ? "" : "s"} (env=${args.environment ?? "dev"})`,
    );
    // Cache hit short-circuit. Pre-fix re-previewing an unchanged draft
    // re-ran every step end-to-end (109 calls to api.digitalocean.com
    // for the f00b8d1c session). Hash the draft + input; if a recent
    // success exists, replay the cached envelope instead of hitting
    // the upstream again.
    const cacheKey = buildDryRunCacheKey({
      tenant_id: ctx.tenant_id,
      execution_mode: args.environment ?? "dev",
      draft: definition,
      input: args.input ?? null,
    });
    const cached = readDryRunCache(cacheKey);
    let run: Awaited<ReturnType<typeof runExecution>>;
    if (cached) {
      ctx.onLog?.(
        "info",
        `cache hit · replaying ${cached.steps.length} step(s) without upstream calls`,
      );
      run = cached;
    } else {
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
            execution_mode: args.environment ?? "dev",
            ...(signal ? { signal } : {}),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          data: {
            error: msg,
            reason: (err as { code?: string }).code ?? "draft_run_failed",
          },
        };
      }
      writeDryRunCache(cacheKey, run);
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

    const stoppedForDraft = stoppedId ?? lastStep?.step_id ?? "(end)";
    const runWarnings = (run.warnings ?? []).map((w) => ({
      step_key: (w as { step_key?: string | null }).step_key ?? null,
      code: (w as { code?: string }).code ?? "unknown",
      message: (w as { message?: string }).message ?? "",
    }));
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
    const dryRunRequiresRepair = runWarnings.some(
      (w) =>
        w.code === "unresolved_identifier" ||
        w.code === "transform_empty_extraction" ||
        w.code === "loop_over_unresolved" ||
        w.code === "loop_body_empty",
    );

    // authoring_scope_changed — compare each step's available_paths
    // against the previous dry-run's recorded scope_at_step. When
    // paths disappear (e.g. an upstream API silently drops a field
    // between v1 and v2), surface a non-fatal warning so the LLM
    // notices BEFORE patching downstream transforms against the new
    // shape. Pre-fix the LLM patched a transform against shape v1,
    // re-ran, the API returned v2, the transform silently dropped
    // fields, and the spiral was indistinguishable from a typo.
    //
    // mutation_seq guard: only compare against previous traces when
    // the workflow draft hasn't been structurally rewritten in the
    // interim. The previewed-checkpoint records the seq at preview
    // time; if the workflow_mutation_seq has advanced past that, the
    // step ids may have moved meaning and the comparison is
    // misleading. We require: previous preview's stored seq matches
    // current workflow_mutation_seq.
    const draftNow = ctx.getDraft();
    const previousTraces = draftNow.latest_preview?.step_traces ?? [];
    const previewCheckpoint = draftNow.state?.checkpoints?.workflow_previewed;
    const draftSeq = draftNow.state?.workflow_mutation_seq ?? 0;
    const previewSeq = previewCheckpoint?.mutation_seq ?? -1;
    const sameDraftAsPreview = previewSeq === draftSeq && previousTraces.length > 0;
    const previousByStep = new Map<string, { available_paths: string[] }>();
    if (sameDraftAsPreview) {
      for (const t of previousTraces) {
        if (t.scope_at_step?.available_paths) {
          previousByStep.set(t.step_id, { available_paths: t.scope_at_step.available_paths });
        }
      }
    }
    const scopeChangedWarnings: Array<{
      step_key: string;
      code: string;
      message: string;
    }> = [];
    for (const s of run.steps) {
      const prev = previousByStep.get(s.step_key);
      if (!prev) continue;
      if (s.output_preview === undefined || s.output_preview === null) continue;
      const cur = buildScopeAtStep(s.output_preview).available_paths;
      const curSet = new Set(cur);
      const removed = prev.available_paths.filter((p) => !curSet.has(p));
      if (removed.length > 0) {
        scopeChangedWarnings.push({
          step_key: s.step_key,
          code: "authoring_scope_changed",
          message: `step "${s.step_key}" no longer surfaces ${removed.length} previously-recorded path(s): ${removed
            .slice(0, 5)
            .map((p) => `\`${p}\``)
            .join(
              ", ",
            )}${removed.length > 5 ? `, +${removed.length - 5} more` : ""}. Downstream transforms / loops authored against the prior shape may silently drop fields.`,
        });
      }
    }
    runWarnings.push(...scopeChangedWarnings);

    // Build the persisted per-step trace. The conversation context-
    // assembler reads this off `latest_preview.step_traces` on every
    // authoring turn so the LLM sees the most recent shape per step
    // without re-reading the dry_run envelope. We materialise a
    // compact view here (drop request_meta from the persisted
    // version — it's cheap to keep around in the response envelope
    // but not worth the token cost on every turn).
    const persistedStepTraces = run.steps.map((s) => {
      const errorCode =
        s.error && typeof s.error === "object" && s.error !== null
          ? (s.error as { code?: unknown }).code
          : undefined;
      const scope =
        s.output_preview !== undefined && s.output_preview !== null
          ? buildScopeAtStep(s.output_preview)
          : undefined;
      return {
        step_id: s.step_key,
        kind: s.kind,
        status: s.status,
        ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
        ...(s.output_preview !== undefined && s.output_preview !== null
          ? { output_preview: s.output_preview }
          : {}),
        ...(s.raw_preview !== undefined && s.raw_preview !== null
          ? { raw_preview: s.raw_preview }
          : {}),
        ...(scope ? { scope_at_step: scope } : {}),
        ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
      };
    });

    const nextDraft = withLatestPreview(
      ctx.getDraft(),
      {
        ok: run.status === "succeeded",
        step_id: stoppedForDraft,
        summary: lastStep?.summary ?? `Run completed with status ${run.status}.`,
        preview: lastStep?.output_preview ?? null,
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        ...(dryRunRequiresRepair ? { requires_repair: true } : {}),
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
    // Mirrors the reference implementation's `run_tool({
    // includeStepResults: true })` envelope — gives the LLM a single
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

    return {
      ok: run.status === "succeeded",
      data: buildLifecyclePayload(nextDraft, {
        steps_ran: run.steps.length,
        duration_ms: run.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0),
        classification:
          lastStep?.classification ?? (run.status === "succeeded" ? "ok" : "driver_error"),
        stopped_at_step_id: stoppedId,
        summary:
          run.status === "succeeded"
            ? `Ran ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} with no errors.`
            : `Run stopped at step \`${stoppedForDraft}\`: ${lastStep?.summary ?? run.error?.message ?? "unknown error"}`,
        execution_id: run.execution_id,
        // Top-level banner so the LLM can't miss warnings on first
        // read. `warnings` (legacy field) stays for back-compat
        // consumers but the banner is the canonical surface.
        ...(warningsBanner ? { warnings_banner: warningsBanner } : {}),
        ...(runWarnings.length > 0 ? { warnings: runWarnings } : {}),
        step_trace: stepTrace,
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
      }),
    };
  },
};
