// inspect_execution — read a completed execution's step-level diagnosis:
// per-step status, duration, warnings, truncated output previews, and
// scope shapes.
//
// The surface-agnostic sibling of inspect_execution_step. It is a
// tenant_read — a pure (ctx, args) function over tenant-scoped tables —
// so it runs unchanged on the chat and MCP surfaces. diagnose_latest_execution
// covers the same ground for the chat authoring loop, but that tool is
// draft_write (it stashes the diagnosis into the conversation draft) and
// is therefore unavailable on the stateless MCP surface. MCP callers use
// this tool instead.

import { z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { buildExecutionDiagnosis } from "./execution-diagnosis.ts";
import type { ConversationTool } from "./index.ts";

const Input = z
  .object({
    execution_id: z
      .string()
      .uuid()
      .optional()
      .describe("Execution to inspect. Omit to inspect the tenant's most recent execution."),
  })
  .openapi("InspectExecutionToolInput");

export const inspectExecutionTool: ConversationTool = {
  name: "inspect_execution",
  description:
    "Inspect a completed execution with its structured `outcome` (kind, failed step, cause class, step counts, output-contract verdict) and step-level diagnosis — per-step status, duration, warnings, truncated output previews, and scope shapes — so the next edit is grounded in the real runtime output. Omit execution_id to inspect the tenant's most recent execution.",
  use_case:
    "Check why a run failed or warned, or see the actual per-step output shapes before authoring a transform. Available on both the chat and MCP surfaces.",
  important_notes: [
    "Omit execution_id to inspect the tenant's most recent execution.",
    "Step output previews are truncated to fit the LLM context. For a single step's full (possibly offloaded) payload, use inspect_execution_step with include_full_payload:true.",
    "Refuses with execution_not_found when an explicit execution_id does not exist on this tenant, and no_executions when the tenant has run nothing yet.",
  ],
  inputSchema: Input,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    let executionId = args.execution_id ?? null;
    if (!executionId) {
      // Tenant-scoped — resolve the most recent execution for this tenant.
      const latest = await ctx.db
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.tenant_id, ctx.tenant_id))
        .orderBy(desc(executions.created_at))
        .limit(1);
      executionId = latest[0]?.id ?? null;
      if (!executionId) {
        return {
          ok: false,
          data: {
            error_code: "no_executions",
            message: "this tenant has no executions to inspect — run a workflow first",
          },
        };
      }
    }
    const [result, row] = await Promise.all([
      buildExecutionDiagnosis(ctx.db, ctx.tenant_id, executionId),
      ctx.engineClient.executions.get(executionId),
    ]);
    if (!result.found || !row) {
      return {
        ok: false,
        data: {
          error_code: "execution_not_found",
          message: `no execution ${executionId} on this tenant`,
        },
      };
    }
    return {
      ok: true,
      data: {
        execution: result.execution,
        outcome: await ctx.engineClient.executions.outcome(row),
        diagnosis: result.diagnosis,
      },
    };
  },
};
