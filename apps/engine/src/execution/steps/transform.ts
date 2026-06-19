// Transform step driver. The expression is a JavaScript function body
// executed in the QuickJS sandbox: the body sees `input` shaped
// `{ scope, input }` (upstream step outputs at `input.scope.<id>.data`, the
// workflow input at `input.input`) and its `return` value becomes the step
// output. JSONata is NOT a transform language — it survives only in the
// one-line slots (`data_selector`, `branch.when`, `output_transform`, and
// `${scope.x.data}` string interpolation), evaluated by their own drivers.
//
// The three web-scraper languages (`readability`, `html-to-markdown`,
// `structured-data`) read the upstream HTML body via `input` and emit a
// typed JSON envelope; they carry no `expression`.
//
// The transform timeout tier (default `sandbox.transform_wall_ms`, 60 s)
// applies to every language — the JS body races against the QuickJS
// wall-clock budget plus the execution abort signal so external cancels
// still land. QuickJS runs synchronously and blocks the worker for the
// whole call, so this tier is deliberately short; chunk via `for_each`
// rather than raising it.

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
import { runHtmlToMarkdown, runReadability, runStructuredData } from "./transform-web-scraper.ts";

export interface RunTransformParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

// Effective transform wall-clock: the operator-tunable
// `sandbox.transform_wall_ms` when config is loaded, else the static
// fallback. A per-step `timeout_ms` still overrides this upstream.
function configuredTransformWallMs(): number {
  try {
    return getConfig().sandbox.transform_wall_ms;
  } catch {
    return TRANSFORM_TIMEOUT_DEFAULT_MS;
  }
}

export async function runTransformStep(p: RunTransformParams): Promise<StepResult> {
  // Wrap the whole transform run in a single rss-delta sample. Transforms
  // are the dominant memory hog in the executor: a large projection over
  // loop output can balloon the heap. One delta per transform (not per
  // sub-eval) keeps the signal attributable without log spam.
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
  // A transform is a downstream consumer of the scope. When an upstream
  // loop spilled large body payloads to storage, the loop key in `scope`
  // holds `OffloadRef` placeholders — re-hydrate them here so the transform
  // body sees the original arrays. The helper returns the SAME object when
  // nothing is offloaded, so the common case pays only one shallow scan.
  // Reassigning the local params field cannot mutate the engine's `scope`
  // (the resolved copy is fresh). A re-hydration failure throws and fails
  // this step.
  p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
  // Web-scraper — three static-import branches that operate on the
  // upstream HTML body and emit a typed JSON envelope. These do not race
  // against the abort signal because each is synchronous and bounded by its
  // own max_chars cap.
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
  // The schema superRefine enforces a non-empty expression for the JS
  // language; this guard is defence-in-depth for callers that bypass the
  // parser.
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
    // QuickJS already enforces its own wall-clock safety net — we pass the
    // step timeout as `wall_ms` and race against the same abort signal so
    // external cancels still land. The body addresses upstream data as
    // `input.scope.<step_id>.data…` and the workflow input as `input.input`.
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
  } catch (err) {
    const duration_ms = Date.now() - start;
    // Derive the user-facing message via `buildStepErrorDetail.safeMessage`.
    // The detail is reused on the failed-return path below so the logger and
    // the LLM see the same message.
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
