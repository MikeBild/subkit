import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { executionVisibilityFilter, isSensitivePayload } from "../../execution/index.ts";
import { OffloadResolutionError, resolveOffloaded } from "../../execution/offload.ts";
import type { ConversationTool } from "./index.ts";

const Input = z
  .object({
    execution_id: z.string().uuid(),
    step_key: z
      .string()
      .min(1)
      .describe(
        "Step id within the workflow definition (e.g. 'fetch_projects', 'project_loop'). Match the step's `id` field, not the row id.",
      ),
    include_full_payload: z.boolean().default(false),
  })
  .openapi("InspectExecutionStepToolInput");

function nextBestActionsFor(kind: string, step_key: string): string[] {
  switch (kind) {
    case "loop":
      return [
        "When iterating over a loop output, the canonical scope path is `$scope.<loop_id>.data[i].<body_step_id>.data.<field>`. Look at output_preview[0] to see the body_step_id keys for this loop.",
        "dry_run_transform — author + test the next projection expression against this real shape before saving.",
      ];
    case "request":
      return [
        `The request body is at \`$scope.${step_key}.data\`; status / headers live on the same envelope. Use this when authoring downstream transforms.`,
        "dry_run_transform — author + test the next projection expression against this real shape before saving.",
        "run_workflow — rerun with new input via the input_schema, or edit_workflow_patch to adjust the upstream connector params.",
      ];
    case "transform":
      return [
        "The transform's projected shape is in output_preview. If it dropped fields, see suggest_jsonata_paths for the available scope keys.",
        "dry_run_transform — re-author the expression against this real shape before saving.",
        "edit_workflow_patch — adjust the upstream step or the downstream transform.",
      ];
    default:
      return [
        "dry_run_transform — author + test the next projection expression against this real shape before saving.",
        "edit_workflow_patch — adjust the upstream step or the downstream transform.",
      ];
  }
}

export const inspectExecutionStepTool: ConversationTool = {
  name: "inspect_execution_step",
  description:
    "Read the persisted output of a single step from a completed execution. Use AFTER a run when the formatted workflow output looks suspicious (empty array, missing fields the user asked for) — fetch the upstream step's actual output_preview to see the real scope shape, then fix the JSONata projection. The preferred alternative to guessing or running the workflow again with a different transform.",
  use_case:
    "Debug a transform projection that silently dropped fields, or understand the actual shape of a loop body output. Returns output_preview (capped) by default; pass include_full_payload:true to fetch the offloaded body when needed.",
  important_notes: [
    "Step is found by step_key (matches the `id` in the workflow definition), not by the database row id.",
    "Returns output_preview by default — that's the same shape the engine wrote to logs and is sufficient to author transforms in 99% of cases.",
    "Returns request_meta on request steps so the LLM can see method, URL, status_code, header_keys (audit-safe — values are not exposed).",
    "When the step's payload was offloaded for size, output_preview is a truncated summary; pass include_full_payload:true to fetch the full body from execution_fixtures.",
    "Refuses with `step_not_found` if the step_key did not match any row on this execution.",
  ],
  inputSchema: Input,
  category: "tenant_read",
  permission: {
    action: "execution:read",
    resourceType: "execution",
    resourceIdArg: "execution_id",
  },
  async execute(ctx, rawArgs) {
    const args = Input.parse(rawArgs);
    if (!ctx.principal) return { ok: false, data: { error_code: "principal_required" } };
    const execRows = await ctx.db
      .select({
        id: executions.id,
        tenant_id: executions.tenant_id,
        status: executions.status,
        workflow_id: executions.workflow_id,
        input: executions.input,
      })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, ctx.tenant_id),
          eq(executions.id, args.execution_id),
          executionVisibilityFilter(ctx.principal),
        ),
      )
      .limit(1);
    const exec = execRows[0];
    if (!exec) {
      return {
        ok: false,
        data: {
          error_code: "execution_not_found",
          message: `no execution ${args.execution_id} on this tenant`,
        },
      };
    }
    if (isSensitivePayload(exec.input)) {
      return { ok: false, data: { error_code: "sensitive_execution_unsupported" } };
    }

    const stepRows = await ctx.db
      .select({
        id: executionSteps.id,
        step_key: executionSteps.step_key,
        kind: executionSteps.kind,
        status: executionSteps.status,
        output_preview: executionSteps.output_preview,
        result_storage_uri: executionSteps.result_storage_uri,
        result_sha256: executionSteps.result_sha256,
        request_meta: executionSteps.request_meta,
        credential_snapshots: executionSteps.credential_snapshots,
        duration_ms: executionSteps.duration_ms,
        retry_count: executionSteps.retry_count,
        error: executionSteps.error,
      })
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenant_id),
          eq(executionSteps.execution_id, args.execution_id),
          eq(executionSteps.step_key, args.step_key),
        ),
      )
      .limit(1);
    const step = stepRows[0];
    if (!step) {
      const allSteps = await ctx.db
        .select({
          step_key: executionSteps.step_key,
          status: executionSteps.status,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, ctx.tenant_id),
            eq(executionSteps.execution_id, args.execution_id),
          ),
        );
      return {
        ok: false,
        data: {
          error_code: "step_not_found",
          message: `step '${args.step_key}' did not run in execution ${args.execution_id}`,
          available_steps: allSteps,
        },
      };
    }

    let fullPayload: unknown;
    let payloadSource: "preview" | "offload" | "none" = step.output_preview ? "preview" : "none";
    if (args.include_full_payload && step.result_storage_uri) {
      try {
        fullPayload = await resolveOffloaded(ctx.db, ctx.tenant_id, {
          $offloaded: true,
          storage_uri: step.result_storage_uri,
          preview: JSON.stringify(step.output_preview ?? null),
          size_bytes: 0,
          ...(step.result_sha256 ? { sha256: step.result_sha256 } : {}),
        });
        payloadSource = "offload";
      } catch (error) {
        if (!(error instanceof OffloadResolutionError)) throw error;
        return {
          ok: false,
          data: {
            error_code: error.code,
            message: error.message,
            execution_id: args.execution_id,
            step_key: step.step_key,
          },
        };
      }
    }

    return {
      ok: true,
      data: {
        execution_id: args.execution_id,
        workflow_id: exec.workflow_id,
        execution_status: exec.status,
        step_key: step.step_key,
        kind: step.kind,
        status: step.status,
        duration_ms: step.duration_ms,
        retry_count: step.retry_count,
        credential_snapshots: step.credential_snapshots ?? [],
        ...(step.error ? { error: step.error } : {}),
        ...(step.request_meta ? { request_meta: step.request_meta } : {}),
        output_preview: step.output_preview,
        ...(fullPayload !== undefined ? { full_payload: fullPayload } : {}),
        payload_source: payloadSource,
        offloaded: step.result_storage_uri !== null,
        next_best_actions: nextBestActionsFor(step.kind, step.step_key),
      },
    };
  },
};
