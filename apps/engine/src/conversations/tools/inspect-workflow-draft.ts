import { z } from "@hono/zod-openapi";
import { classifyRequestStepSideEffects } from "../../execution/steps/request/side-effects.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { getWorkflowDraft, withWorkflowInspection } from "../authoring-state.ts";
import type { WorkflowDraftStepPreview } from "../types.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("InspectWorkflowDraftToolInput");

export const inspectWorkflowDraftTool: ConversationTool = {
  name: "inspect_workflow_draft",
  description:
    "Inspect the current workflow draft, including step order, validation summary, latest preview, and the recommended next action. Each step entry is enriched with its most recent output_preview + scope_at_step (when a dry-run / run has been recorded) so the LLM can author downstream transforms / loops against real shapes.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
  async execute(ctx): Promise<ToolResult> {
    const nextDraft = withWorkflowInspection(ctx.getDraft());
    await ctx.setDraft(nextDraft);
    const workflow = getWorkflowDraft(nextDraft);

    // Index latest_preview.step_traces by step_id so each step entry
    // can carry its own preview side-by-side with config. Pre-fix
    // the LLM had to call inspect_workflow as a separate step round-
    // trip to read scope shapes per step; now they ride along on
    // every inspect_workflow_draft call.
    const traceById = new Map<string, WorkflowDraftStepPreview>();
    const traces = nextDraft.latest_preview?.step_traces;
    if (Array.isArray(traces)) {
      for (const t of traces) traceById.set(t.step_id, t);
    }

    return {
      ok: true,
      data: buildLifecyclePayload(
        nextDraft,
        {
          name: workflow.name,
          steps: workflow.steps.length,
          last_step_id: workflow.steps[workflow.steps.length - 1]?.id ?? null,
          step_type:
            typeof workflow.steps[workflow.steps.length - 1]?.kind === "string"
              ? (workflow.steps[workflow.steps.length - 1]?.kind as string)
              : null,
          workflow: {
            name: workflow.name,
            slug: workflow.slug ?? null,
            description: workflow.description ?? null,
            step_count: workflow.steps.length,
            steps: workflow.steps.map((step, index) => {
              const id = typeof step.id === "string" ? step.id : `step-${index + 1}`;
              const trace = traceById.get(id);
              // surface each step's side-effect class so the agent
              // knows which steps DISPATCH (sends, writes) and never
              // live-tests them (it verifies via dry_run_workflow / a held
              // run instead). Reuses the engine's canonical classifier — the
              // same one hold_writes uses — so the label can't drift from
              // what the engine actually holds. A `call` step runs a
              // sub-workflow whose own steps may write, so it is marked
              // "write" conservatively (the agent should not blind-live-test
              // it). Pure-compute / control-flow steps (transform, loop,
              // branch, parallel, wait) have no external side effect → "read".
              const sideEffect =
                step.kind === "request"
                  ? classifyRequestStepSideEffects(step as unknown as RequestStep)
                  : step.kind === "call"
                    ? "write"
                    : "read";
              return {
                index,
                id,
                kind: typeof step.kind === "string" ? step.kind : "unknown",
                side_effect: sideEffect,
                fields: Object.keys(step).sort(),
                ...(trace
                  ? {
                      latest_preview: {
                        status: trace.status,
                        ...(trace.duration_ms != null ? { duration_ms: trace.duration_ms } : {}),
                        ...(trace.output_preview !== undefined
                          ? { output_preview: trace.output_preview }
                          : {}),
                        ...(trace.raw_preview !== undefined
                          ? { raw_preview: trace.raw_preview }
                          : {}),
                        ...(trace.scope_at_step ? { scope_at_step: trace.scope_at_step } : {}),
                        ...(trace.error_code ? { error_code: trace.error_code } : {}),
                      },
                    }
                  : { latest_preview: { status: "no_result" } }),
              };
            }),
            edges: workflow.edges ?? [],
          },
          latest_preview: nextDraft.latest_preview ?? null,
        },
        { readOnly: true },
      ),
    };
  },
};
