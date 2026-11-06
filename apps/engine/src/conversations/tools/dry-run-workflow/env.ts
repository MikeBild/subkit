import { z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { runExecution } from "../../../execution/engine.ts";
import type { ExecutionMode, RunResult } from "../../../execution/types.ts";
import type { StepDef, WorkflowDef } from "../../../workflows/types.ts";
import type { DryRunWarning } from "../../core/dry-run.ts";
import type { PreviewAutoRepair } from "../../preview-auto-repair.ts";
import type { WorkflowDraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";

export const inputSchema = z
  .object({
    input: z.unknown().optional(),
    mode: z
      .enum(["schema_only"])
      .optional()
      .describe(
        "Sensitive drafts only. `schema_only` validates the definition and compiles its expressions without running any step: no request is dispatched, no data is read, nothing is returned or stored but structure findings. Use it when the encrypted metadata test run is refused or must not read data. It reports structure checked, content not checked; live verification happens in the Cockpit by the signed-in person.",
      ),
    environment: z.enum(["dev", "prod"]).optional(),
    budget_ms_per_step: z.number().int().min(500).max(60_000).optional(),
    include_step_results: z
      .boolean()
      .optional()
      .describe(
        "Attach a `step_results` array carrying the RAW per-step input (the resolved request the step issued, or the held request for a write) side-by-side with its output. Default false keeps the envelope compact (the truncated `step_trace`). Turn on to self-diagnose whether a bad final output is a step-config bug (the request went out wrong) or an output_transform bug (the step was fine, the projection dropped the data). Ignored for sensitive drafts.",
      ),
  })
  .openapi("DryRunWorkflowToolInput");

export type DryRunArgs = z.infer<typeof inputSchema>;

export interface DryRunEnv {
  ctx: ToolContext;
  args: DryRunArgs;
  draft: WorkflowDraftDocument;
  steps: StepDef[];
  author: ResolvedPrincipal | null;
  environment: ExecutionMode;
  previewInput: unknown;
  signal: AbortSignal | undefined;
}

export interface PreviewRun {
  run: RunResult;
  definition: WorkflowDef;
  autoRepair: PreviewAutoRepair | null;
}

export type Warnings = DryRunWarning[];

export function runDraft(
  env: DryRunEnv,
  definition: WorkflowDef,
  stepOutputFixtures: Record<string, unknown> | undefined,
): Promise<RunResult> {
  return runExecution({
    db: env.ctx.db,
    tenant_id: env.ctx.tenant_id,
    source: {
      kind: "draft",
      definition,
      ...(env.draft.name ? { name: env.draft.name } : {}),
    },
    input: env.previewInput,
    options: {
      request_source: "chat",
      execution_mode: env.environment,
      hold_writes: true,
      principal: env.author,
      ...(env.signal ? { signal: env.signal } : {}),
      ...(stepOutputFixtures ? { step_output_fixtures: stepOutputFixtures } : {}),
    },
  });
}
