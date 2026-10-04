import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import {
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxTimeoutError,
} from "../../sandboxes/quickjs/types.ts";
import type { TransformStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import { resolveScopeForJsonata } from "../jsonata-bindings.ts";
import { TRANSFORM_TIMEOUT_DEFAULT_MS } from "../timeouts.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";
import { detectTransformWarnings } from "./transform-warnings.ts";
import { runHtmlToMarkdown, runReadability, runStructuredData } from "./transform-web-scraper.ts";

export interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

function configuredTransformWallMs(): number {
  try {
    return getConfig().sandbox.transform_wall_ms;
  } catch {
    return TRANSFORM_TIMEOUT_DEFAULT_MS;
  }
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
  const timeoutMs = p.step.timeout_ms ?? configuredTransformWallMs();
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  const language = p.step.language ?? "javascript";
  p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
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
      input: { scope: p.scope, input: p.input },
      limits: { wall_ms: timeoutMs },
      clock: {
        now_ms: p.ctx.started_at.getTime(),
        seed: `${p.ctx.evaluation_seed ?? p.ctx.execution_id}:${p.step.id}`,
      },
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
    const output = (raced as { output: unknown }).output;
    const warnings = detectTransformWarnings({ step_id: p.step.id, output, scope: p.scope });
    return {
      status: "succeeded",
      output,
      retry_count: 0,
      duration_ms: Date.now() - start,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const detail = buildStepErrorDetail({ code: "transform_error", err });
    const message = detail.message;
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
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
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
        error: { code: "transform_memory", message },
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
        error: { code: "transform_timeout", message: `transform exceeded ${timeoutMs}ms` },
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
      error: detail,
    };
  } finally {
    clearTimeout(timer);
  }
}
