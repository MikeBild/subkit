// inspect_workflow — read multiple sections + per-step config and
// captured results from the current draft in one call.
//
// API shape mirrors the reference impl's inspect_tool:
//   sections: ["instruction" | "input_schema" | "output_schema" |
//              "output_transform" | "payload" | "response_filters"]
//   steps:    [{ stepId, include: ["config" | "result" |
//                                   "data_selector" | "instruction"] }]
//
// Authoring loops produced 30+ iterations of update_param when the LLM
// guessed scope paths instead of reading the actual captured shape.
// inspect_workflow returns config + captured result side-by-side so the
// next patch is authored against the real shape, not an imagined one.

import { z } from "@hono/zod-openapi";
import { getWorkflowDraft } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const SectionEnum = z.enum([
  "instruction",
  "input_schema",
  "output_schema",
  "output_transform",
  "payload",
  "response_filters",
]);

const StepIncludeEnum = z.enum(["config", "result", "data_selector", "instruction"]);

const Input = z
  .object({
    sections: z
      .array(SectionEnum)
      .optional()
      .describe(
        "Top-level sections of the workflow draft to return in full. Multi-select; combine with steps[] in one call.",
      ),
    steps: z
      .array(
        z.object({
          stepId: z.string().min(1),
          include: z.array(StepIncludeEnum).min(1),
        }),
      )
      .optional()
      .describe(
        "Per-step requests. `result` returns the captured output_preview from the most recent dry_run / run for that step.",
      ),
  })
  .openapi("InspectWorkflowToolInput");

export const inspectWorkflowTool: ConversationTool = {
  name: "inspect_workflow",
  description:
    "Inspect specific parts of the current workflow draft and the captured results from its most recent dry_run / run, in one call. Multi-section + multi-step. Returns each step's config side-by-side with its actual output_preview so subsequent patches reference the real scope shape, not a guessed path.",
  use_case:
    "Before calling update_param for the third time on the same field, call this once to see the captured shape of every step. Author the next patch against the returned shape, not an imagined one.",
  important_notes: [
    "Both `sections` and `steps` accept multiple items — combine all the introspection you need into one call instead of round-tripping per step.",
    "`result` returns the per-step output_preview from the most recent dry_run_workflow / run_workflow attached to the draft. If no preview has run yet, the field is { status: 'no_result' }.",
    "Step ids must match the workflow definition's `id` field, not the database row id.",
  ],
  inputSchema: Input,
  category: "tenant_read",
  requires_skill: "workflow-authoring",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = Input.parse(rawArgs);
    const draft = ctx.getDraft();
    const workflow = getWorkflowDraft(draft);
    // Build the captured-results lookup. The canonical surface is
    // `latest_preview.step_traces` populated by dry_run_workflow /
    // run_workflow — one entry per step with output_preview,
    // raw_preview, and scope_at_step.
    const previewSteps = (() => {
      const latest = draft.latest_preview as
        | { step_traces?: Array<Record<string, unknown>> }
        | null
        | undefined;
      const m = new Map<string, Record<string, unknown>>();
      if (Array.isArray(latest?.step_traces)) {
        for (const trace of latest!.step_traces!) {
          const id = (trace as { step_id?: unknown }).step_id;
          if (typeof id === "string") m.set(id, trace);
        }
      }
      return m;
    })();

    const result: Record<string, unknown> = {};
    const wf = workflow as unknown as Record<string, unknown>;
    if (args.sections && args.sections.length > 0) {
      for (const section of args.sections) {
        switch (section) {
          case "instruction":
            result.instruction = workflow.description ?? null;
            break;
          case "input_schema":
            result.input_schema = wf.input_schema ?? null;
            break;
          case "output_schema":
            result.output_schema = wf.output_schema ?? null;
            break;
          case "output_transform":
            result.output_transform = wf.output_transform ?? null;
            break;
          case "payload": {
            // Prefer the schema sample (declared canonical input).
            // When absent, fall back to the most recent dry_run /
            // run input persisted on latest_preview.input — gives
            // the LLM a concrete payload to author against without
            // requiring the user to maintain input_schema_sample.
            const samplePayload = wf.input_schema_sample;
            const recentInput = (draft.latest_preview as { input?: unknown } | null | undefined)
              ?.input;
            result.payload = samplePayload ?? recentInput ?? null;
            break;
          }
          case "response_filters":
            result.response_filters = wf.response_filters ?? null;
            break;
        }
      }
    }

    if (args.steps && args.steps.length > 0) {
      const stepResults: Array<Record<string, unknown>> = [];
      for (const req of args.steps) {
        const step = workflow.steps.find(
          (s) =>
            typeof (s as { id?: unknown }).id === "string" &&
            (s as { id: string }).id === req.stepId,
        ) as Record<string, unknown> | undefined;
        if (!step) {
          stepResults.push({
            step_id: req.stepId,
            error: "step_not_found",
            available_step_ids: workflow.steps
              .map((s) => (s as { id?: unknown }).id)
              .filter((id): id is string => typeof id === "string"),
          });
          continue;
        }
        const entry: Record<string, unknown> = { step_id: req.stepId };
        for (const inc of req.include) {
          switch (inc) {
            case "config": {
              // Strip transient fields from the step itself; everything
              // else IS the step config in the flattened shape.
              const { id: _id, kind: _kind, ...config } = step as Record<string, unknown>;
              entry.config = config;
              entry.kind = step.kind ?? null;
              break;
            }
            case "result": {
              const captured = previewSteps.get(req.stepId);
              entry.result = captured ?? { status: "no_result" };
              break;
            }
            case "data_selector":
              entry.data_selector = step.data_selector ?? null;
              break;
            case "instruction":
              entry.instruction = step.description ?? step.instruction ?? null;
              break;
          }
        }
        stepResults.push(entry);
      }
      result.steps = stepResults;
    }

    return {
      ok: true,
      data: {
        workflow_name: workflow.name ?? null,
        workflow_slug: workflow.slug ?? null,
        step_count: workflow.steps.length,
        has_latest_preview: previewSteps.size > 0,
        ...result,
      },
    };
  },
};
