// Single-step execution helper. Wraps `runExecution` with source.kind="step"
// so a StepDef can be tested in isolation with the exact same driver code
// path as a normal workflow run.
//
// Use cases:
//   • CLI: `sk run --step step.json`
//   • HTTP: `POST /v1/executions {source:"step", ...}`
//   • Conversation: `dry_run_step` now routes here instead of previewStep
//
// Scope handling: callers can preseed `scope` so the step sees prior step
// outputs (`$scope.<id>`). The step itself is wrapped in a one-step
// WorkflowDef synthesized inside the resolver.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { StepDef } from "../workflows/types.ts";

import { runExecution } from "./engine.ts";
import type { ExecutionMode, RequestSource, RunResult } from "./types.ts";

export interface RunSingleStepParams {
  db: Db;
  tenant_id: string;
  step: StepDef | unknown;
  /** `$input` seed for the step — accessible via `$input.*` selectors. */
  input?: unknown;
  /** Prior step outputs keyed by step id. Expression contexts can read
   *  `$scope.<id>.data`, mirroring the shape a real workflow sees. */
  scope?: Record<string, unknown>;
  environment?: ExecutionMode;
  /** Upper bound on the wall-clock time the step may consume before an
   *  abort signal fires. Defaults to 60s. Authors testing transforms
   *  usually want 5s; driver-heavy steps want more. */
  timeout_ms?: number;
  signal?: AbortSignal;
  request_source?: RequestSource;
  principal?: ResolvedPrincipal | null;
  /** Human-readable label persisted into executions.source_ref so operators
   *  can tell which step-run corresponds to which authoring action. */
  workflow_slug?: string;
  trace_id?: string | null;
}

export async function runSingleStep(p: RunSingleStepParams): Promise<RunResult> {
  const timeout = p.timeout_ms ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("step_timeout"), timeout);
  const signal = p.signal ? mergeSignals(p.signal, ctrl.signal) : ctrl.signal;

  try {
    return await runExecution({
      db: p.db,
      tenant_id: p.tenant_id,
      source: {
        kind: "step",
        step: p.step,
        ...(p.workflow_slug ? { workflow_slug: p.workflow_slug } : {}),
      },
      input: p.input ?? null,
      options: {
        request_source: p.request_source ?? "api",
        execution_mode: p.environment ?? "dev",
        signal,
        trace_id: p.trace_id ?? null,
        ...(p.principal ? { principal: p.principal } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Platform `AbortSignal.any` — the hand-rolled version leaked one listener
// per call onto the long-lived caller signal (never removed on completion).
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}
