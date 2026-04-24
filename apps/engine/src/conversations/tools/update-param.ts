// update_param — replace a single field on an existing step.

import { z } from "@hono/zod-openapi";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    step_id: z.string().min(1),
    param: z.string().min(1),
    value: z.unknown(),
  })
  .openapi("UpdateParamToolInput");

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function parseParamPath(param: string): string[] {
  return param
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function applyParamPath(
  target: Record<string, unknown>,
  param: string,
  value: unknown,
): Record<string, unknown> {
  const segments = parseParamPath(param);
  if (segments.length === 0) {
    throw new Error("param must contain at least one path segment");
  }
  for (const segment of segments) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new Error(`param path contains forbidden segment: ${segment}`);
    }
  }
  const next = structuredClone(target);
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const current = cursor[segment];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      cursor = current as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
  cursor[segments[segments.length - 1]!] = value;
  return next;
}

export const updateParamTool: ConversationTool = {
  name: "update_param",
  description:
    "Replace a single field on an existing step in the draft. Supports dotted paths like `graphql.query`.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const workflowDraft = structuredClone(getWorkflowDraft(currentDraft));
    const idx = workflowDraft.steps.findIndex((s) => s.id === args.step_id);
    if (idx < 0) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "unknown_step",
          message: `step not found: ${args.step_id}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
        }),
      };
    }
    let step: Record<string, unknown>;
    try {
      step = applyParamPath(workflowDraft.steps[idx] ?? {}, args.param, args.value);
    } catch (err) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "step_update_invalid",
          message: err instanceof Error ? err.message : String(err),
          recommended_mode: "workflow",
          extra: {
            errors: [
              {
                path: args.param,
                message: err instanceof Error ? err.message : String(err),
              },
            ],
            step_id: args.step_id,
            param: args.param,
          },
        }),
      };
    }
    workflowDraft.steps[idx] = step;
    const validation = validateWorkflowDef(workflowDraft);
    if (!validation.ok) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "step_update_invalid",
          message: "step update would leave the workflow draft invalid",
          recommended_mode: "workflow",
          extra: {
            errors: validation.errors,
            step_id: args.step_id,
            param: args.param,
          },
        }),
      };
    }
    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_step_updated");
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          step_id: args.step_id,
          param: args.param,
          steps: workflowDraft.steps.length,
          step_type: typeof step.kind === "string" ? step.kind : null,
          last_step_id: workflowDraft.steps[workflowDraft.steps.length - 1]?.id ?? null,
        },
      }),
    };
  },
};
