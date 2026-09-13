import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ErrorSchema } from "../../../api/common-schemas.ts";
import { runSummarizeFlow } from "../../../llm/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const MAX_SUMMARIZE_INPUT_CHARS = 10_000;

const SummarizeBody = z
  .object({
    prompt: z.string().min(1).max(MAX_SUMMARIZE_INPUT_CHARS),
  })
  .openapi("AiSummarizeBody");

const SummarizeResponse = z
  .object({
    summary: z.string(),
    tokens: z.record(z.string(), z.number()),
    model_used: z.string(),
    fell_back: z.boolean(),
  })
  .openapi("AiSummarizeResponse");

const route = createRoute({
  method: "post",
  path: "/v1/ai/summarize",
  tags: ["ai"],
  summary: "Summarize arbitrary text into a compact plain-text response",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: SummarizeBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SummarizeResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerAiSummarizeRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/ai/summarize", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:read")(c, next);
  });

  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const result = await runSummarizeFlow(
      {
        tenant_id: principal.tenant_id,
        prompt: body.prompt,
      },
      db,
    );
    return c.json(
      {
        summary: result.summary,
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
