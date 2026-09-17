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
      }),
    ),
    iterations: z.array(
      z.object({
        step_id: z.string(),
        kind: z.enum(["loop", "for_each"]),
        body_step_ids: z.array(z.string()),
      }),
    ),
    run_limit_is_request_limit: z.literal(false),
  })
  .openapi("AuthorityExecutionShape");

/** Structural review only: never evaluate selectors or infer a total wire-call bound.
 * A loop can repeat a static target; retries count per invocation, not per run.
 * Auth refreshes and other transport activity are not business request attempts.
 */
export function authorityExecutionShape(
  definition: WorkflowDef,
  bindings: readonly Pick<ResolvedEffectBinding, "step_id" | "driver" | "storage">[],
): z.infer<typeof AuthorityExecutionShapeSchema> {
  const storage = new Map(
    bindings
      .filter((binding) => binding.storage)
      .map((binding) => [binding.step_id, binding.storage]),
  );
  const drivers = new Map(bindings.map((binding) => [binding.step_id, binding.driver]));
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
            },
          ]
        : [],
    ),
    iterations: definition.steps.flatMap((step) => [
      ...(step.kind === "loop"
        ? [{ step_id: step.id, kind: "loop" as const, body_step_ids: step.body }]
        : []),
      ...(step.for_each
        ? [{ step_id: step.id, kind: "for_each" as const, body_step_ids: [step.id] }]
        : []),
    ]),
    run_limit_is_request_limit: false,
  };
}
