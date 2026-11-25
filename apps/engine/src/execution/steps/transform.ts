import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/index.ts";
import {
  recordSandboxLimitClamped,
  recordSandboxTransform,
  type SandboxTransformOutcome,
} from "../../observability/instrumentation.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { sandboxFailureCode } from "../../sandboxes/index.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { pruneScopeForJs } from "../../sandboxes/quickjs/scope-references.ts";
import {
  SandboxError,
  SandboxInterruptError,
  SandboxMemoryError,
  type SandboxStats,
  SandboxTimeoutError,
} from "../../sandboxes/quickjs/types.ts";
import type { TransformStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import { resolveScopeForJsonata } from "../jsonata-bindings.ts";
import { sensitiveFailure } from "../sensitive-payload.ts";
import { TRANSFORM_TIMEOUT_DEFAULT_MS, TRANSFORM_WALL_CEILING_DEFAULT_MS } from "../timeouts.ts";
import type { RequestMeta, StepResult, StepRunContext } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";
import { runParseFile } from "./parse-file.ts";
import { transformInputFor } from "./transform-input.ts";
import { detectTransformWarnings } from "./transform-warnings.ts";
import { runHtmlToMarkdown, runReadability, runStructuredData } from "./transform-web-scraper.ts";

interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

function sandboxTransformLimits(): { transform_wall_ms: number; max_transform_wall_ms: number } {
  try {
    const sandbox = getConfig().sandbox;
    return {
      transform_wall_ms: sandbox.transform_wall_ms,
      max_transform_wall_ms: sandbox.max_transform_wall_ms,
    };
  } catch {
    return {
      transform_wall_ms: TRANSFORM_TIMEOUT_DEFAULT_MS,
      max_transform_wall_ms: TRANSFORM_WALL_CEILING_DEFAULT_MS,
    };
  }
}

export function effectiveTransformWallMs(stepTimeoutMs: number | undefined): {
  wall_ms: number;
  clamped: boolean;
} {
  const limits = sandboxTransformLimits();
  const requested = stepTimeoutMs ?? limits.transform_wall_ms;
  const wall_ms = Math.min(requested, limits.max_transform_wall_ms);
  return { wall_ms, clamped: wall_ms < requested };
}

function transformTimeoutMessage(
  step: TransformStep,
  wall: ReturnType<typeof effectiveTransformWallMs>,
): string {
  const base = `transform exceeded ${wall.wall_ms}ms`;
  if (!wall.clamped) return base;
  const requested =
    step.timeout_ms === undefined
      ? "the configured sandbox.transform_wall_ms"
      : `timeout_ms ${step.timeout_ms}`;
  return `${base} (operator ceiling sandbox.max_transform_wall_ms; ${requested} was clamped)`;
}

export function sandboxRequestMeta(stats: SandboxStats | undefined): {
  request_meta?: RequestMeta;
} {
  if (!stats) return {};
  return {
    request_meta: {
      driver: "sandbox",
      ticks: Math.max(0, Math.trunc(stats.ticks)),
      duration_ms: Math.max(0, Math.round(stats.duration_ms)),
      peak_memory_bytes:
        stats.peak_memory_bytes === null ? null : Math.max(0, Math.trunc(stats.peak_memory_bytes)),
    },
  };
}

export async function runTransformStep(p: RunTransformParams): Promise<StepResult> {
  return instrument({
    module: "execution",
    action: "transform",
    memory: true,
    fields: { step_id: p.step.id, language: p.step.language ?? "javascript" },
    fn: () => runTransformStepInner(p),
  });
}

async function runTransformStepInner(p: RunTransformParams): Promise<StepResult> {
  const start = Date.now();
  const wall = effectiveTransformWallMs(p.step.timeout_ms);
  const timeoutMs = wall.wall_ms;
  if (wall.clamped) {
    recordSandboxLimitClamped({ field: "transform_wall_ms" });
    logger.warn({
      module: "execution",
      action: "step.transform.wall_clamped",
      step_id: p.step.id,
      requested_timeout_ms: p.step.timeout_ms ?? null,
      wall_ms: timeoutMs,
    });
  }
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  const language = p.step.language ?? "javascript";
  p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
  const transformInput = transformInputFor(p.step, p.scope, p.input);
  if (!transformInput.ok) {
    clearTimeout(timer);
    logger.warn({
      module: "execution",
      action: "step.transform.input_missing",
      step_id: p.step.id,
      language,
      input_from: p.step.input_from,
    });
    return {
      status: "failed",
      error: { code: "transform_input_missing", message: transformInput.message },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  }
  p.input = transformInput.value;
  if (language === "readability") {
    clearTimeout(timer);
    return runReadability({ ctx: p.ctx, step: p.step, input: p.input });
  }
  if (language === "html-to-markdown") {
    clearTimeout(timer);
    return runHtmlToMarkdown({ ctx: p.ctx, step: p.step, input: p.input });
  }
  if (language === "structured-data") {
    clearTimeout(timer);
    return runStructuredData({ ctx: p.ctx, step: p.step, input: p.input });
  }
  if (language === "parse-file") {
    clearTimeout(timer);
    return runParseFile({ ctx: p.ctx, step: p.step, scope: p.scope, input: p.input });
  }
  if (!p.step.expression) {
    clearTimeout(timer);
    return {
      status: "failed",
      error: {
        code: "transform_error",
        message: `transform.language=${language} requires a non-empty expression`,
      },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  }
  try {
    const jsPromise = runJs({
      code: p.step.expression,
      input: { scope: pruneScopeForJs(p.step.expression, p.scope).scope, input: p.input },
      limits: { wall_ms: timeoutMs },
      clock: {
        now_ms: p.ctx.started_at.getTime(),
        seed: `${p.ctx.evaluation_seed ?? p.ctx.execution_id}:${p.step.id}`,
      },
      signal,
    });
    const raced = await Promise.race([
      jsPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    const { output, stats } = raced as { output: unknown; stats?: SandboxStats };
    const warnings = detectTransformWarnings({ step_id: p.step.id, output, scope: p.scope });
    logSandboxStats(p.step.id, stats, "succeeded");
    return {
      status: "succeeded",
      output,
      retry_count: 0,
      duration_ms: Date.now() - start,
      ...sandboxRequestMeta(stats),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const privateCode = p.ctx.execution_privacy === "sensitive" ? sandboxFailureCode(err) : null;
    const privateError = privateCode ? sensitiveFailure(privateCode) : null;
    const detail = buildStepErrorDetail({ code: "transform_error", err });
    const message = detail.message;
    const stats = err instanceof SandboxError ? err.stats : undefined;
    logSandboxStats(
      p.step.id,
      stats,
      err instanceof SandboxTimeoutError || err instanceof SandboxInterruptError
        ? "timed_out"
        : err instanceof SandboxMemoryError
          ? "memory"
          : "failed",
    );
    if (err instanceof SandboxTimeoutError || err instanceof SandboxInterruptError) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        ...sandboxRequestMeta(stats),
        error: privateError ?? {
          code: "transform_timeout",
          message: transformTimeoutMessage(p.step, wall),
        },
      };
    }
    if (err instanceof SandboxMemoryError) {
      logger.warn({
        module: "execution",
        action: "step.transform.memory_error",
        step_id: p.step.id,
        language,
        duration_ms,
        error: message,
      });
      return {
        status: "failed",
        retry_count: 0,
        duration_ms,
        ...sandboxRequestMeta(stats),
        error: privateError ?? { code: "transform_memory", message },
      };
    }
    if (timeoutCtrl.signal.aborted && !p.ctx.signal.aborted) {
      logger.warn({
        module: "execution",
        action: "step.transform.timeout",
        step_id: p.step.id,
        language,
        timeout_ms: timeoutMs,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "transform_timeout", message: transformTimeoutMessage(p.step, wall) },
      };
    }
    if (p.ctx.signal.aborted) {
      return {
        status: "aborted",
        retry_count: 0,
        duration_ms,
        error: { code: "aborted", message: "execution aborted" },
      };
    }
    logger.warn({
      module: "execution",
      action: "step.transform.error",
      step_id: p.step.id,
      language,
      duration_ms,
      error: message,
    });
    return {
      status: "failed",
      retry_count: 0,
      duration_ms,
      ...sandboxRequestMeta(stats),
      error: privateError ?? detail,
    };
  } finally {
    clearTimeout(timer);
  }
}

function logSandboxStats(
  stepId: string,
  stats: SandboxStats | undefined,
  outcome: SandboxTransformOutcome,
): void {
  if (!stats) return;
  recordSandboxTransform({
    outcome,
    duration_ms: stats.duration_ms,
    peak_memory_bytes: stats.peak_memory_bytes,
  });
  logger.debug({
    module: "sandbox",
    action: "transform.stats",
    step_id: stepId,
    ticks: stats.ticks,
    duration_ms: stats.duration_ms,
    peak_memory_bytes: stats.peak_memory_bytes,
    worker_pid: stats.worker_pid ?? null,
  });
}
