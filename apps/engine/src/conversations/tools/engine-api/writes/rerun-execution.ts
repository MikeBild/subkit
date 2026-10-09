import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { executions } from "../../../../db/schema/index.ts";
import {
  admitWorkflowRun,
  executionVisibilityFilter,
  runExecution,
} from "../../../../execution/index.ts";
import {
  authorizeSensitiveResume,
  isSensitivePayload,
  recoverExecutionPayload,
} from "../../../../execution/sensitive-payload.ts";
import { gateWorkflowRunRbac } from "../../../../workflows/rbac.ts";
import type { ConversationTool } from "../../index.ts";
import { sampleWorkflowOutputForLlm } from "../../truncate.ts";

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
    const rows = await ctx.db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenant_id),
          eq(executions.id, args.execution_id),
          executionVisibilityFilter(ctx.principal),
        ),
      )
      .limit(1);
    const original = rows[0];
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

    const rbac = await gateWorkflowRunRbac({
      db: ctx.db,
      principal: ctx.principal,
      workflow_id: original.workflow_id,
      request_source: "chat",
      tool: "rerun_execution",
    });
    if (!rbac.allow) {
      return { ok: false, data: { error: "permission_denied", detail: rbac.reason } };
    }

    if (isSensitivePayload(original.input))
      await authorizeSensitiveResume(ctx.db, original, ctx.principal);
    const input =
      args.input !== undefined
        ? args.input
        : recoverExecutionPayload(original.input, ctx.tenant_id, original.id);
    if (!original.workflow_version_id)
      return { ok: false, data: { error: "workflow_version_unavailable" } };
    const admitted = await admitWorkflowRun(
      {
        tenant_id: ctx.tenant_id,
        workflow_id: original.workflow_id,
        workflow_version_id: original.workflow_version_id,
        request_source: "chat",
        parent_execution_id: original.id,
        execution_environment: original.execution_mode ?? "dev",
        input,
      },
      ctx.db,
      ctx.principal,
      rbac.workflow_permission,
    );
    const execution_id = admitted.execution_id;

    const result = await runExecution({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      source: {
        kind: "saved",
        workflow_id: original.workflow_id,
        ...(original.workflow_version_id ? { version_id: original.workflow_version_id } : {}),
      },
      input: admitted.input,
      options: {
        request_source: "chat",
        principal: ctx.principal,
        execution_mode: original.execution_mode ?? "dev",
        parent_execution_id: original.id,
        existing_execution_id: execution_id,
      },
    });

    return {
      ok: result.status === "succeeded",
      data: {
        execution_id: result.execution_id,
        rerun_of: original.id,
        status: result.status,
        hold_writes: admitted.hold_writes,
        output: sampleWorkflowOutputForLlm(result.output),
        ...(result.error ? { error: result.error } : {}),
      },
    };
  },
};
