import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { StepDef } from "../workflows/types.ts";

import { runExecution } from "./engine.ts";
import type { ExecutionMode, RequestSource, RunResult } from "./types.ts";

export interface RunSingleStepParams {
  db: Db;
  tenant_id: string;
  step: StepDef | unknown;
  input?: unknown;
  scope?: Record<string, unknown>;
  environment?: ExecutionMode;
  timeout_ms?: number;
  signal?: AbortSignal;
  request_source?: RequestSource;
  principal?: ResolvedPrincipal | null;
  workflow_slug?: string;
  trace_id?: string | null;
  hold_writes?: boolean;
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
        ...(p.hold_writes !== undefined ? { hold_writes: p.hold_writes } : {}),
        trace_id: p.trace_id ?? null,
        ...(p.principal ? { principal: p.principal } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}
