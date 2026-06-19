// rerun_execution tool — faithful rerun of a saved-workflow execution.
//
// Mirrors POST /v1/executions/{id}/rerun: same workflow_version_id as
// the original, original input by default (overridable), lineage via
// parent_execution_id + source_ref.rerun_of. Confirm-gated via
// tool-policies (it triggers real connector calls).

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { executions } from "../../../../db/schema/index.ts";
import { createExecution, runExecution } from "../../../../execution/index.ts";
import { gateWorkflowRunRbac } from "../../../../workflows/rbac.ts";
import type { ConversationTool } from "../../index.ts";
import { sampleWorkflowOutputForLlm } from "../../truncate.ts";

const RerunInput = z
  .object({
    execution_id: z.string().uuid(),
    /** Override the original input. Omit to reuse it verbatim. */
    input: z.unknown().optional(),
  })
  .openapi("RerunExecutionToolInput");

export const rerunExecutionTool: ConversationTool = {
  name: "rerun_execution",
  description:
    "Rerun a finished execution: same workflow version, same input (unless overridden), with lineage back to the original (parent_execution_id). Use after a fix or a transient failure to verify the run now succeeds.",
  inputSchema: RerunInput,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = RerunInput.parse(rawArgs);
    const rows = await ctx.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.id, args.execution_id)))
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

    if (ctx.principal) {
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
    }

    const input = args.input !== undefined ? args.input : (original.input ?? null);
    const execution_id = await createExecution(ctx.db, {
      tenant_id: ctx.tenant_id,
      workflow_id: original.workflow_id,
      workflow_version_id: original.workflow_version_id,
      source_kind: "saved",
      source_ref: { rerun_of: original.id },
      request_source: "chat",
      parent_execution_id: original.id,
      execution_mode: original.execution_mode ?? "dev",
      input,
    });

    const result = await runExecution({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      source: {
        kind: "saved",
        workflow_id: original.workflow_id,
        ...(original.workflow_version_id ? { version_id: original.workflow_version_id } : {}),
      },
      input,
      options: {
        request_source: "chat",
        ...(ctx.principal ? { principal: ctx.principal } : {}),
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
        output: sampleWorkflowOutputForLlm(result.output),
        ...(result.error ? { error: result.error } : {}),
      },
    };
  },
};
