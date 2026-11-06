import { z } from "@hono/zod-openapi";
import { findVisibleExecutionRow, loadRerunSafety } from "../../../../execution/index.ts";
import {
  authorizeSensitiveResume,
  isSensitivePayload,
  recoverExecutionPayload,
} from "../../../../execution/sensitive-payload.ts";
import { completedRun, createRunWorkflow } from "../../../../execution/use-cases/run-workflow.ts";
import { sampleWorkflowOutputForLlm } from "../../../../tools/truncate.ts";
import type { ConversationTool } from "../../index.ts";

const RerunInput = z
  .object({
    execution_id: z.string().uuid(),
    input: z.unknown().optional(),
  })
  .openapi("RerunExecutionToolInput");

export const rerunExecutionTool: ConversationTool = {
  name: "rerun_execution",
  description:
    "Rerun a finished execution: same workflow version, same input (unless overridden), with lineage back to the original (parent_execution_id). Use after a fix or a transient failure to verify the run now succeeds.",
  inputSchema: RerunInput,
  category: "tenant_write",
  async execute(ctx, args: z.infer<typeof RerunInput>) {
    if (!ctx.principal) return { ok: false, data: { error: "principal_required" } };
    if (ctx.principal.tenant_id !== ctx.tenant_id)
      return { ok: false, data: { error: "permission_denied" } };
    const original = await findVisibleExecutionRow(ctx.db, ctx.principal, args.execution_id);
    if (!original) return { ok: false, data: { error: "execution_not_found" } };
    if (original.source_kind !== "saved" || !original.workflow_id) {
      return {
        ok: false,
        data: {
          error: "not_rerunnable",
          detail: `source_kind='${original.source_kind}' — only saved-workflow executions can be rerun; re-run draft/step definitions directly`,
        },
      };
    }

    const useCase = createRunWorkflow({ db: ctx.db });
    const grant = await useCase.authorize({
      principal: ctx.principal,
      workflow_id: original.workflow_id,
      via: "chat",
      tool: "rerun_execution",
    });
    if (grant.kind === "rejected") {
      return { ok: false, data: { error: "permission_denied", detail: grant.reason } };
    }

    if (isSensitivePayload(original.input))
      await authorizeSensitiveResume(ctx.db, original, ctx.principal);
    const input =
      args.input !== undefined
        ? args.input
        : recoverExecutionPayload(original.input, ctx.tenant_id, original.id);
    if (!original.workflow_version_id)
      return { ok: false, data: { error: "workflow_version_unavailable" } };
    const execution_environment = original.execution_mode ?? "dev";
    const safety = await loadRerunSafety(ctx.db, ctx.tenant_id, original);
    const outcome = await useCase.runWorkflow({
      principal: ctx.principal,
      workflow_id: original.workflow_id,
      workflow_version_id: original.workflow_version_id,
      request_source: "chat",
      parent_execution_id: original.id,
      execution_environment,
      ...(safety.mode !== "repeat_safe" ? { hold_writes: true } : {}),
      input,
      authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
      audit_extra: { rerun_of: original.id },
      dispatch: { mode: "inline" },
    });
    const { admitted, result } = completedRun(outcome);

    return {
      ok: result.status === "succeeded",
      data: {
        execution_id: result.execution_id,
        rerun_of: original.id,
        status: result.status,
        hold_writes: admitted.hold_writes,
        rerun_safety: safety,
        output: sampleWorkflowOutputForLlm(result.output),
        ...(result.error ? { error: result.error } : {}),
      },
    };
  },
};
