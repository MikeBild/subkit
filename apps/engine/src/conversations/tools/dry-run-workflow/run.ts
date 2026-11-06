import { actorOf } from "../../../audit/actor.ts";
import { resolveDryRunEnvironment } from "../../../credentials/service.ts";
import type { ExecutionMode, RunResult } from "../../../execution/types.ts";
import type { StepDef, WorkflowDef } from "../../../workflows/types.ts";
import { stepFixtureEnvelope } from "../../core/dry-run.ts";
import {
  attemptPreviewAutoRepair,
  recordPreviewAutoRepairOutcome,
} from "../../preview-auto-repair.ts";
import { buildGateError } from "../authoring-contract.ts";
import { draftPreviewInput } from "../draft-preview-input.ts";
import {
  buildDryRunCacheKey,
  buildStepPrefixHash,
  isStepKindCacheable,
  readDryRunCache,
  readStepFixture,
  writeDryRunCache,
  writeStepFixture,
} from "../dry-run-cache.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { type DryRunArgs, type DryRunEnv, type PreviewRun, runDraft } from "./env.ts";

export async function resolvePreviewSetup(
  ctx: ToolContext,
  args: DryRunArgs,
  steps: StepDef[],
): Promise<{ blocked: ToolResult } | { environment: ExecutionMode; previewInput: unknown }> {
  const environment = await resolveDryRunEnvironment({
    tenant_id: ctx.tenant_id,
    steps,
    requested: args.environment,
    exec: ctx.db,
    conversation_id: ctx.conversation_id,
    onLog: ctx.onLog,
  });
  try {
    const previewInput = await draftPreviewInput(
      ctx.db,
      ctx.tenant_id,
      ctx.getDraft(),
      environment,
      args.input,
    );
    return { environment, previewInput };
  } catch (error) {
    return {
      blocked: {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "preview_input_unavailable",
          message:
            error instanceof Error ? error.message : "Could not resolve saved preview inputs",
          next_best_actions: ["list_schedules", "ask_user_form"],
        }),
      },
    };
  }
}

function cacheableStepId(step: StepDef | undefined): string | null {
  const candidate = step as { id?: unknown; kind?: unknown } | undefined;
  if (!candidate || typeof candidate.id !== "string") return null;
  return isStepKindCacheable(candidate.kind, candidate) ? candidate.id : null;
}

function stepPrefixHash(env: DryRunEnv, cacheInput: unknown, stepIndex: number): string {
  return buildStepPrefixHash({
    tenant_id: env.ctx.tenant_id,
    execution_mode: env.environment,
    draft: { steps: env.steps, ...(env.draft.name ? { name: env.draft.name } : {}) },
    input: cacheInput,
    stepIndex,
  });
}

function replayPrefix(
  env: DryRunEnv,
  cacheInput: unknown,
): { stepOutputFixtures: Record<string, unknown>; prefixReplayCount: number } {
  const stepOutputFixtures: Record<string, unknown> = {};
  let prefixReplayCount = 0;
  for (let i = 0; i < env.steps.length; i++) {
    const stepId = cacheableStepId(env.steps[i]);
    if (stepId === null) break;
    const fixture = readStepFixture(stepPrefixHash(env, cacheInput, i));
    if (fixture === null) break;
    stepOutputFixtures[stepId] = fixture;
    prefixReplayCount++;
  }
  return { stepOutputFixtures, prefixReplayCount };
}

function storeStepFixtures(env: DryRunEnv, cacheInput: unknown, run: RunResult): void {
  for (let i = 0; i < env.steps.length; i++) {
    const stepId = cacheableStepId(env.steps[i]);
    if (stepId === null) continue;
    const envelope = stepFixtureEnvelope(run.steps.find((s) => s.step_key === stepId));
    if (envelope === null) continue;
    writeStepFixture(stepPrefixHash(env, cacheInput, i), envelope);
  }
}

function runFailure(env: DryRunEnv, definition: WorkflowDef, err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const reason = (err as { code?: string }).code ?? "draft_run_failed";
  if (reason === "input_schema_violation") {
    const inputSchema = (definition as { input_schema?: unknown }).input_schema ?? null;
    return {
      ok: false,
      error_code: reason,
      message: msg,
      data: {
        ...buildGateError(env.ctx.getDraft(), {
          error_code: reason,
          message: `${msg}. The preview input must match input_schema exactly: supply every required field with the declared type and no other fields, then call dry_run_workflow again.`,
          next_best_actions: ["dry_run_workflow"],
        }),
        error: msg,
        reason,
        input_schema: inputSchema,
        rejected_input: env.previewInput ?? null,
      },
    };
  }
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

export async function executePreview(
  env: DryRunEnv,
  definition: WorkflowDef,
): Promise<{ blocked: ToolResult } | { run: RunResult }> {
  const { ctx } = env;
  const cacheInput = { caller: env.author, input: env.previewInput ?? null };
  const cacheKey = buildDryRunCacheKey({
    tenant_id: ctx.tenant_id,
    execution_mode: env.environment,
    draft: definition,
    input: cacheInput,
  });
  const cached = readDryRunCache(cacheKey);
  if (cached) {
    ctx.onLog?.(
      "info",
      `cache hit · replaying ${cached.steps.length} step(s) without upstream calls`,
    );
    return { run: cached };
  }
  const { stepOutputFixtures, prefixReplayCount } = replayPrefix(env, cacheInput);
  if (prefixReplayCount > 0) {
    ctx.onLog?.(
      "info",
      `prefix cache hit · replaying ${prefixReplayCount} upstream step(s) from fixture`,
    );
  }
  let run: RunResult;
  try {
    run = await runDraft(env, definition, prefixReplayCount > 0 ? stepOutputFixtures : undefined);
  } catch (err) {
    return { blocked: runFailure(env, definition, err) };
  }
  writeDryRunCache(cacheKey, run);
  storeStepFixtures(env, cacheInput, run);
  return { run };
}

export async function applyAutoRepair(
  env: DryRunEnv,
  run: RunResult,
  definition: WorkflowDef,
): Promise<PreviewRun> {
  const { ctx } = env;
  const outcome = await attemptPreviewAutoRepair({
    run,
    definition,
    previewInput: env.previewInput ?? null,
    tenant_id: ctx.tenant_id,
    db: ctx.db,
    rerun: (repaired, step_output_fixtures) => runDraft(env, repaired, step_output_fixtures),
    ...(env.signal ? { signal: env.signal } : {}),
  });
  const draftBefore = ctx.getDraft();
  const draftAfter = recordPreviewAutoRepairOutcome({
    outcome,
    draft: draftBefore,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    actor: env.author ? actorOf(env.author) : null,
    db: ctx.db,
  });
  if (draftAfter !== draftBefore) await ctx.setDraft(draftAfter);
  if (!outcome.repaired) return { run, definition, autoRepair: null };
  ctx.onLog?.(
    "info",
    `${outcome.auto_repair.site} repaired in-preview and verified by a fixture re-run`,
  );
  return { run: outcome.run, definition: outcome.definition, autoRepair: outcome.auto_repair };
}
