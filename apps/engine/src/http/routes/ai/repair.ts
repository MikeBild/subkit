// POST /v1/ai/repair — propose a patch for a drifted failing step.
//
// The self-healing loop in P7 hands us an execution id + the failing
// step + a textual drift diff. We run the repair flow and return the
// normalised PatchProposal envelope. The caller decides whether to
// stage, auto-apply, or reject.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { runRepairFlow } from "../../../llm/flows/repair.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const RepairBody = z
  .object({
    execution_id: z.string(),
    failing_step_id: z.string(),
    drift_diff: z.string().min(1),
    connector_id: z.string().uuid().optional(),
    failing_request: z.unknown().optional(),
    failing_response: z.unknown().optional(),
  })
  .openapi("AiRepairBody");

const RepairResponse = z
  .object({
    patch_proposal: z.object({
      classification: z.enum(["safe", "unsafe"]),
      kind: z.enum([
        "update_field_path",
        "rename_param",
        "change_type",
        "add_header",
        "rate_limited",
        "other",
      ]),
      description: z.string(),
      patch: z.record(z.string(), z.unknown()),
      reasoning: z.string(),
    }),
    included_skills: z.array(z.string()),
    included_chunks: z.array(z.string()),
    tokens: z.record(z.string(), z.number()),
    model_used: z.string(),
    fell_back: z.boolean(),
  })
  .openapi("AiRepairResponse");

const route = createRoute({
  method: "post",
  path: "/v1/ai/repair",
  tags: ["ai"],
  summary: "Propose a patch for a drifted failing step",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: RepairBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RepairResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerAiRepairRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/ai/repair", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:write")(c, next);
  });

  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const result = await runRepairFlow(
      {
        tenant_id: principal.tenant_id,
        execution_id: body.execution_id,
        failing_step: {
          id: body.failing_step_id,
          ...(body.failing_request !== undefined ? { request: body.failing_request } : {}),
          ...(body.failing_response !== undefined ? { response: body.failing_response } : {}),
        },
        drift_diff: body.drift_diff,
        ...(body.connector_id ? { connector_id: body.connector_id } : {}),
      },
      db,
    );
    return c.json(
      {
        patch_proposal: result.patch_proposal,
        included_skills: result.included_skill_ids,
        included_chunks: result.included_chunk_ids,
        tokens: {
          system: result.tokens.system,
          skills: result.tokens.skills,
          docs: result.tokens.docs,
          failures: result.tokens.failures,
          messages: result.tokens.messages,
          total: result.tokens.total,
        },
        model_used: result.model_used,
        fell_back: result.fell_back,
      },
      200,
    );
  });
}
