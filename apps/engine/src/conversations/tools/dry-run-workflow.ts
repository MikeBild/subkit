import { getWorkflowDraft } from "../authoring-state/index.ts";
import { dryRunStartLine } from "../core/dry-run.ts";
import { previewAutoRepairCondition } from "../preview-auto-repair.ts";
import { listRecentToolCallOutputs } from "../service/tool-state.ts";
import { authorConnectorWriteWarnings } from "./author-build-warnings.ts";
import { type DryRunEnv, inputSchema } from "./dry-run-workflow/env.ts";
import { gateDraft } from "./dry-run-workflow/gates.ts";
import { type RecentToolCalls, repairLoopGate } from "./dry-run-workflow/repair-loop.ts";
import { reportPreview } from "./dry-run-workflow/report.ts";
import { applyAutoRepair, executePreview, resolvePreviewSetup } from "./dry-run-workflow/run.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { resolveConversationPrincipal } from "./permission-gate.ts";
import { runSensitiveDryRun } from "./sensitive-dry-run.ts";
import { runSensitiveSchemaPreview } from "./sensitive-schema-preview.ts";

const recentToolCalls: RecentToolCalls = (ctx) => listRecentToolCallOutputs(ctx.db, ctx, 8);

export const dryRunWorkflowTool: ConversationTool = {
  name: "dry_run_workflow",
  description:
    "Run the entire draft workflow via runExecution (source=draft), producing an auditable executions row. Read steps execute for real; WRITE steps are always HELD — resolved for inspection but never dispatched. Live writes require an immutable saved workflow version and its bounded execution or prepared one-shot approval. Omit input when repairing an existing scheduled workflow: the engine reuses its single enabled schedule in this environment. Explicit input, including {}, is preserved. Never invent dummy identifiers or destinations for real read requests. External destinations must come from the user, never fabricated placeholders. A sensitive draft (execution_privacy: sensitive) runs encrypted and returns only `sensitive_test_run` metadata: step statuses, held steps, safe failure codes, item counts, check verdicts and declared output field types. Values are never returned; do not guess them. When that test run is refused or must not read data, mode `schema_only` checks only structure.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = getWorkflowDraft(ctx.getDraft());
    const sensitiveDraft = Reflect.get(draft, "execution_privacy") === "sensitive";
    const gated = await gateDraft(ctx, args, draft, sensitiveDraft);
    if ("blocked" in gated) return gated.blocked;
    const { steps, definition, inheritedReferencesField } = gated.passed;

    if (sensitiveDraft && args.mode === "schema_only") {
      return runSensitiveSchemaPreview({ ctx, definition: { ...definition } });
    }

    const author = ctx.principal ?? (await resolveConversationPrincipal(ctx));
    const authorPermissionWarnings = author
      ? await authorConnectorWriteWarnings(
          ctx.db,
          author,
          ctx.tenant_id,
          steps as unknown as Array<Record<string, unknown>>,
        )
      : [];

    const repairLoopBlock = await repairLoopGate(ctx, recentToolCalls);
    if (repairLoopBlock) return repairLoopBlock;

    const setup = await resolvePreviewSetup(ctx, args, steps);
    if ("blocked" in setup) return setup.blocked;
    const env: DryRunEnv = {
      ctx,
      args,
      draft,
      steps,
      author,
      environment: setup.environment,
      previewInput: setup.previewInput,
      signal: ctx.abortSignal,
    };

    ctx.onLog?.("info", dryRunStartLine(steps.length, env.environment));
    if (sensitiveDraft) {
      return runSensitiveDryRun({
        ctx,
        definition,
        draftName: draft.name,
        previewInput: env.previewInput,
        environment: env.environment,
        principal: author,
      });
    }

    const executed = await executePreview(env, definition);
    if ("blocked" in executed) return executed.blocked;
    const preview = previewAutoRepairCondition(executed.run)
      ? await applyAutoRepair(env, executed.run, definition)
      : { run: executed.run, definition, autoRepair: null };
    return reportPreview(env, preview, authorPermissionWarnings, inheritedReferencesField);
  },
};
