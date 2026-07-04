// GET /v1/operator/health-digest — deterministic operator health digest.
//
// The `sk` REPL fetches this at startup and renders it as a colored
// first assistant turn ("I noticed N issues… walk through fixes?"),
// then injects the structured payload as conversation context so the
// LLM can act on the failures. Server-computed, LLM-free, tenant-scoped.
// Gated by `stats:read` — it's a runtime-status read, same family as
// /v1/stats/*.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { buildOperatorHealthDigest } from "../../../operator/health-digest.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const FailureGroupSchema = z
  .object({
    signature: z.string(),
    workflow_id: z.string().nullable(),
    workflow_name: z.string().nullable(),
    step_key: z.string().nullable(),
    error_code: z.string().nullable(),
    origin: z.enum(["authoring", "manual", "scheduled", "mixed"]),
    count: z.number().int(),
    last_seen: z.string(),
    cause: z.string(),
    guidance: z.string().nullable(),
  })
  .openapi("OperatorFailureGroup");

const PatchSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string().nullable(),
    workflow_name: z.string().nullable(),
    classification: z.enum(["safe", "unsafe"]),
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
    patch_candidates: z.object({ pending: z.number().int(), items: z.array(PatchSchema) }),
    risk: z.array(RiskSignalSchema),
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
      principal.tenant_id,
      q.window_hours !== undefined ? { window_hours: q.window_hours } : undefined,
    );
    return c.json(digest, 200);
  });
}
