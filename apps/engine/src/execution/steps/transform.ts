// Transform step driver. Supports two languages:
//   - `jsonata` (default): the expression is a JSONata program
//     evaluated against the execution scope plus a `$input` binding.
//   - `javascript` (P14): the expression is a function body executed in
//     the QuickJS sandbox. The JS sees `input` with the full execution
//     scope, and its return value becomes the step output.
//
// The transform timeout tier (default 10 minutes) applies to both
// languages — JSONata races against an abort signal; JavaScript races
// against the QuickJS wall-clock budget plus the same abort signal.

import jsonata from "jsonata";
import { logger } from "../../logging/logger.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import {
  SandboxInterruptError,
  SandboxMemoryError,
  SandboxTimeoutError,
} from "../../sandboxes/quickjs/types.ts";
import type { TransformStep } from "../../workflows/types.ts";
import { combineSignals } from "../abort.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export const TRANSFORM_TIMEOUT_DEFAULT_MS = 10 * 60_000;

export interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

export async function runTransformStep(p: RunTransformParams): Promise<StepResult> {
  const start = Date.now();
  const timeoutMs = p.step.timeout_ms ?? TRANSFORM_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  const language = p.step.language ?? "jsonata";
  try {
    if (language === "javascript") {
      // QuickJS already enforces its own wall-clock safety net — we
      // pass the step timeout as `wall_ms` and race against the same
      // abort signal so external cancels still land.
      const jsPromise = runJs({
        code: p.step.expression,
        input: { scope: p.scope, input: p.input },
        limits: { wall_ms: timeoutMs },
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
      return {
        status: "succeeded",
        output: (raced as { output: unknown }).output,
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    const expr = jsonata(p.step.expression);
    // race jsonata.evaluate against the abort signal
    const evalPromise = expr.evaluate(p.scope, { input: p.input });
    const result = await Promise.race([
      evalPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
    return {
      status: "succeeded",
      output: result,
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
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
      error: { code: "transform_error", message },
    };
  } finally {
    clearTimeout(timer);
  }
}
