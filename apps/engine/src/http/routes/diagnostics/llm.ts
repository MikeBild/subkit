// LLM routing snapshot. Lets operators + smoke probes confirm the
// resolved provider path without exposing any secret material — the
// route surfaces booleans only.
//
//   GET /v1/diagnostics/llm

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { globalLlmStatus } from "../../../llm/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { LlmStatusSchema } from "./schemas.ts";

const llmRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/llm",
  tags: ["diagnostics"],
  summary: "Resolved LLM provider + model snapshot (smoke / triage)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LlmStatusSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerLlmRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(llmRoute, async (c) => {
    requireAuth(c);
    return c.json(globalLlmStatus(), 200);
  });
}
