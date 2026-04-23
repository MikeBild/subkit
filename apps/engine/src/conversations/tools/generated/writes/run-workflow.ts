// run_workflow tool — executes a workflow synchronously in the tenant's
// dev environment (unless the caller opts into prod). Writes an audit
// entry on each attempt.

import { z } from "@hono/zod-openapi";
import { runExecution } from "../../../../execution/engine.ts";
import type { ConversationTool } from "../../index.ts";

const Input = z
  .object({
    workflow_id: z.string().uuid(),
    input: z.unknown().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
  })
  .openapi("RunWorkflowToolInput");

export const runWorkflowTool: ConversationTool = {
  name: "run_workflow",
  description:
    "Execute a workflow synchronously by id. Records an audit entry. Default environment is `dev`.",
  inputSchema: Input,
  category: "tenant_write",
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    const wf = await ctx.engineClient.workflows.get(args.workflow_id);
    if (!wf) return { ok: false, data: { error: "workflow_not_found" } };

    try {
      const result = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: { kind: "saved", workflow_id: args.workflow_id },
        input: args.input ?? null,
        options: {
          request_source: "chat",
          trace_id: null,
          principal: null,
          execution_mode: args.environment,
        },
      });
      await ctx.engineClient.audit_write({
        resource_type: "execution",
        resource_id: result.execution_id,
        action: "conversation.run_workflow",
        result: result.status === "succeeded" ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_id: args.workflow_id,
          environment: args.environment,
          final_status: result.status,
        },
      });
      // Surface non-fatal warnings (unresolved identifiers in transform
      // expressions, schema drift signals) so the LLM / operator sees
      // them next to the output. The execution still succeeded — the
      // warning is an FYI that will become an auto-repair candidate.
      const hasWarnings = (result.warnings?.length ?? 0) > 0;
      return {
        ok: result.status === "succeeded",
        data: {
          execution_id: result.execution_id,
          status: result.status,
          output: result.output,
          error: result.error,
          ...(hasWarnings ? { warnings: result.warnings } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: args.workflow_id,
        action: "conversation.run_workflow",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: false, data: { error: msg } };
    }
  },
};
