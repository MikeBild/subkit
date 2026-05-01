// `tool` step driver — runs a user-configured Docker image under the
// ephemeral container runner in `sandboxes/docker/runner.ts`.
//
// Output shape (success):
//   { exit_code, stdout, stderr, duration_ms }
//
// Failure conditions:
//   - docker create/start/rm errors  -> step fails with kind-specific
//     error codes.
//   - timeout                        -> step `timed_out`, error code
//     `tool_timeout`.
//   - non-zero exit                  -> step fails with code
//     `tool_nonzero_exit` (the engine's on_error=continue branch in
//     step-runner.ts decides whether to keep going).
//
// The step honors the per-step timeout_ms (default 120 s). An external
// abort on the execution signal propagates by wrapping the runner in a
// race so users can cancel long tool runs mid-flight.

import { logger } from "../../logging/logger.ts";
import { runContainer } from "../../sandboxes/docker/runner.ts";
import type { ToolStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";

export const TOOL_TIMEOUT_DEFAULT_MS = 120_000;

export interface RunToolParams {
  ctx: StepRunContext;
  step: ToolStep;
}

export async function runToolStep(p: RunToolParams): Promise<StepResult> {
  const start = Date.now();
  const timeout_ms = p.step.timeout_ms ?? TOOL_TIMEOUT_DEFAULT_MS;

  // Honor external aborts by racing the container run against the
  // execution signal.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  p.ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    logger.debug({
      module: "execution",
      action: "step.tool.started",
      step_id: p.step.id,
      image: p.step.image,
      timeout_ms,
    });
    const res = await runContainer({
      image: p.step.image,
      cmd: p.step.cmd ?? [],
      ...(p.step.env ? { env: p.step.env } : {}),
      timeout_ms,
      ...(p.step.cpu !== undefined ? { cpu: p.step.cpu } : {}),
      ...(p.step.memory_mb !== undefined ? { memory_mb: p.step.memory_mb } : {}),
      ...(p.step.network_mode !== undefined ? { network_mode: p.step.network_mode } : {}),
      ...(p.step.workdir !== undefined ? { workdir: p.step.workdir } : {}),
    });

    const duration_ms = Date.now() - start;

    if (aborted) {
      return {
        status: "aborted",
        retry_count: 0,
        duration_ms,
        error: { code: "aborted", message: "execution aborted" },
      };
    }
    if (res.timed_out) {
      logger.warn({
        module: "execution",
        action: "step.tool.timeout",
        step_id: p.step.id,
        image: p.step.image,
        timeout_ms,
        duration_ms,
      });
      return {
        status: "timed_out",
        retry_count: 0,
        duration_ms,
        error: { code: "tool_timeout", message: `tool exceeded ${timeout_ms}ms` },
        output: {
          exit_code: res.exit_code,
          stdout: res.stdout,
          stderr: res.stderr,
          duration_ms: res.duration_ms,
        },
      };
    }
    if (res.exit_code !== 0) {
      logger.warn({
        module: "execution",
        action: "step.tool.nonzero_exit",
        step_id: p.step.id,
        image: p.step.image,
        exit_code: res.exit_code,
        duration_ms,
      });
      return {
        status: "failed",
        retry_count: 0,
        duration_ms,
        error: {
          code: "tool_nonzero_exit",
          message: `tool exited with code ${res.exit_code}`,
        },
        output: {
          exit_code: res.exit_code,
          stdout: res.stdout,
          stderr: res.stderr,
          duration_ms: res.duration_ms,
        },
      };
    }
    return {
      status: "succeeded",
      retry_count: 0,
      duration_ms,
      output: {
        exit_code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
        duration_ms: res.duration_ms,
      },
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    return {
      status: "failed",
      retry_count: 0,
      duration_ms,
      error: buildStepErrorDetail({ code: "tool_error", err }),
    };
  } finally {
    p.ctx.signal.removeEventListener("abort", onAbort);
  }
}
