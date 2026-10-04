import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { PREVIEW_CLASSIFICATIONS } from "../../../execution/index.ts";
import { buildOperatorHealthDigest } from "../../../operator/health-digest.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { AttentionV1Schema } from "./attention-schema.ts";

const CauseClass = z.enum(PREVIEW_CLASSIFICATIONS).openapi("FailureCauseClass");

const FailureGroupSchema = z
  .object({
    signature: z.string(),
    workflow_id: z.string().nullable(),
    workflow_name: z.string().nullable(),
    step_key: z.string().nullable(),
    error_code: z.string().nullable(),
    origin: z.enum(["authoring", "manual", "scheduled", "mixed"]),
    count: z.number().int(),
    scheduled_count: z.number().int(),
    last_seen: z.string(),
    first_seen: z.string(),
    latest_execution_id: z.string(),
    connector_id: z.string().nullable(),
    resolved_at: z.string().nullable(),
    cause: z.string(),
    cause_class: CauseClass,
    guidance: z.string().nullable(),
  })
  .openapi("OperatorFailureGroup");

const PatchSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string().nullable(),
    workflow_name: z.string().nullable(),
    classification: z.enum(["safe", "unsafe"]),
    age_days: z.number().int().nonnegative(),
    stuck: z.boolean(),
    summary: z.string(),
  })
  .openapi("OperatorDigestPatch");

const RiskSignalSchema = z
  .object({
    kind: z.string(),
    severity: z.enum(["warn", "critical"]),
    headline: z.string(),
    detail: z.string(),
    metric: z.string(),
    value: z.number(),
    threshold: z.number(),
  })
  .openapi("OperatorRiskSignal");

const DigestResponse = z
  .object({
    generated_at: z.string(),
    window_hours: z.number().int(),
    headline: z.string(),
    failure_groups: z.array(FailureGroupSchema),
    patch_candidates: z.object({
      open: z.number().int(),
      items: z.array(PatchSchema),
    }),
    risk: z.array(RiskSignalSchema),
    attention: AttentionV1Schema,
    rendered: z.string(),
    all_clear: z.boolean(),
  })
  .openapi("OperatorHealthDigest");

const digestRoute = createRoute({
  method: "get",
  path: "/v1/operator/health-digest",
  tags: ["operator"],
  summary: "Operator health digest",
  description:
    "Deterministic, LLM-free summary of failed runs (grouped by root cause, tagged by origin) and self-healing fixes awaiting review, over a recent window.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        window_hours: z.coerce.number().int().positive().max(720).optional(),
      })
      .openapi("OperatorHealthDigestQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: DigestResponse } } },
  },
});

export function registerOperatorRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/operator/health-digest", async (c, next) => {
    return requirePermission("stats:read")(c, next);
  });

  app.openapi(digestRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const digest = await buildOperatorHealthDigest(
      db,
      principal,
      q.window_hours !== undefined ? { window_hours: q.window_hours } : undefined,
    );
    return c.json(digest, 200);
  });
}
