import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  buildAgentBriefing,
  DEFAULT_BRIEFING_BUDGET_TOKENS,
  DOMAIN_SLUG_RE,
  MAX_BRIEFING_BUDGET_TOKENS,
  MIN_BRIEFING_BUDGET_TOKENS,
} from "../../agent/briefing.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { can } from "../../rbac/index.ts";
import { BadRequestError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const AgentBriefingResponse = z
  .object({
    markdown: z.string(),
    domains: z.array(z.string()),
    budget_tokens: z.number().int(),
    used_tokens: z.number().int(),
    skills_full: z.array(z.string()),
    skills_title_only: z.array(z.string()),
    knowledge_sources: z.array(z.string()),
    knowledge_sources_omitted: z.number().int(),
    proposed_candidates: z.number().int(),
  })
  .openapi("AgentBriefingResponse");

const briefingRoute = createRoute({
  method: "get",
  path: "/v1/agent/briefing",
  tags: ["agent"],
  summary: "Domain-scoped session briefing for external coding agents",
  description:
    "Returns a budgeted markdown grounding block for the requested domains: " +
    "prescriptive conventions (active skills tagged `domain:<slug>`), a knowledge " +
    "index, and the search-first grounding rule. Intended for SessionStart hooks.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        domains: z
          .string()
          .min(1)
          .openapi({ description: "Comma-separated domain slugs", example: "blog-de" }),
        budget_tokens: z.coerce
          .number()
          .int()
          .min(MIN_BRIEFING_BUDGET_TOKENS)
          .max(MAX_BRIEFING_BUDGET_TOKENS)
          .optional(),
      })
      .openapi("AgentBriefingQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AgentBriefingResponse } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerAgentBriefingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/agent/briefing", requirePermission("skill:read"));

  app.openapi(briefingRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");

    const domains = [...new Set(q.domains.split(",").map((d) => d.trim()))].filter(Boolean);
    if (domains.length === 0 || domains.some((d) => !DOMAIN_SLUG_RE.test(d))) {
      throw new BadRequestError("domains must be comma-separated lowercase slugs (a-z, 0-9, -, _)");
    }

    const knowledgeDecision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "knowledge:read",
      quiet: true,
    });

    const result = await buildAgentBriefing({
      tenant_id: principal.tenant_id,
      domains,
      budget_tokens: q.budget_tokens ?? DEFAULT_BRIEFING_BUDGET_TOKENS,
      include_knowledge_index: knowledgeDecision.allow,
      db,
    });
    return c.json(result, 200);
  });
}
