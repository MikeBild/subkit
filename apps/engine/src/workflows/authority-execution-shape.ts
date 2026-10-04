import { z } from "@hono/zod-openapi";
import { requestMaxAttempts } from "../execution/steps/request.ts";
import { authorityRequestReview } from "./authority-request-review.ts";
import type { ResolvedEffectBinding } from "./effect-manifest.ts";
import type { WorkflowDef } from "./types.ts";

export const AuthorityExecutionShapeSchema = z
  .object({
    requests: z.array(
      z.object({
        step_id: z.string(),
        retry_policy_max_attempts: z.number().int().positive().nullable(),
        redacted_request_json: z.string(),
        request_review_truncated: z.boolean(),
        opaque_payload_omitted: z.boolean(),
        call_path: z.array(z.string()).optional(),
      }),
    ),
    iterations: z.array(
      z.object({
        step_id: z.string(),
        kind: z.enum(["loop", "for_each"]),
        body_step_ids: z.array(z.string()),
        call_path: z.array(z.string()).optional(),
      }),
    ),
    calls: z
      .array(
        z.object({
          step_id: z.string(),
          workflow_id: z.string(),
          workflow_slug: z.string(),
          workflow_name: z.string(),
          version: z.number().int().positive().nullable(),
        }),
      )
      .optional(),
    run_limit_is_request_limit: z.literal(false),
  })
  .openapi("AuthorityExecutionShape");

export type AuthorityExecutionShape = z.infer<typeof AuthorityExecutionShapeSchema>;

export interface ResolvedCallShape {
  step_id: string;
  workflow_id: string;
  workflow_slug: string;
  workflow_name: string;
  version: number | null;
  definition: WorkflowDef;
  bindings: readonly Pick<ResolvedEffectBinding, "step_id" | "driver" | "storage">[];
}

export function authorityExecutionShape(
  definition: WorkflowDef,
  bindings: readonly Pick<ResolvedEffectBinding, "step_id" | "driver" | "storage">[],
  calls: readonly ResolvedCallShape[] = [],
): AuthorityExecutionShape {
  const own = shapeOf(definition, bindings);
  const called = calls.map((call) => ({
    call,
    shape: shapeOf(call.definition, call.bindings, [call.step_id]),
  }));
  return {
    requests: [...own.requests, ...called.flatMap((entry) => entry.shape.requests)],
    iterations: [...own.iterations, ...called.flatMap((entry) => entry.shape.iterations)],
    ...(calls.length > 0
      ? {
          calls: calls.map((call) => ({
            step_id: call.step_id,
            workflow_id: call.workflow_id,
            workflow_slug: call.workflow_slug,
            workflow_name: call.workflow_name,
            version: call.version,
          })),
        }
      : {}),
    run_limit_is_request_limit: false,
  };
}

function shapeOf(
  definition: WorkflowDef,
  bindings: readonly Pick<ResolvedEffectBinding, "step_id" | "driver" | "storage">[],
  call_path?: string[],
): Pick<AuthorityExecutionShape, "requests" | "iterations"> {
  const storage = new Map(
    bindings
      .filter((binding) => binding.storage)
      .map((binding) => [binding.step_id, binding.storage]),
  );
  const drivers = new Map(bindings.map((binding) => [binding.step_id, binding.driver]));
  const path = call_path ? { call_path } : {};
  return {
    requests: definition.steps.flatMap((step) =>
      step.kind === "request"
        ? [
            {
              step_id: step.id,
              ...authorityRequestReview(step),
              ...(storage.has(step.id)
                ? {
                    redacted_request_json: JSON.stringify(storage.get(step.id), null, 2),
                    request_review_truncated: false,
                    opaque_payload_omitted: false,
                  }
                : {}),
              retry_policy_max_attempts: ["http", "graphql", "mcp"].includes(
                drivers.get(step.id) ?? "",
              )
                ? requestMaxAttempts(step)
                : null,
              ...path,
            },
          ]
        : [],
    ),
    iterations: definition.steps.flatMap((step) => [
      ...(step.kind === "loop"
        ? [{ step_id: step.id, kind: "loop" as const, body_step_ids: step.body, ...path }]
        : []),
      ...(step.for_each
        ? [{ step_id: step.id, kind: "for_each" as const, body_step_ids: [step.id], ...path }]
        : []),
    ]),
  };
}
