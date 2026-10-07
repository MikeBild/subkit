import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  buildAgentBriefing,
  DEFAULT_BRIEFING_BUDGET_TOKENS,
  DOMAIN_SLUG_RE,
  MAX_BRIEFING_BUDGET_TOKENS,
  MIN_BRIEFING_BUDGET_TOKENS,
} from "../../agent/briefing.ts";
import {
  DOMAIN_PROMPT_MAX_CHARS,
  DOMAIN_REPO_MAX_CHARS,
  listKnownDomains,
  resolveDomains,
} from "../../agent/domains.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { can, resourceAccess } from "../../rbac/index.ts";
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
    workflows: z
      .array(z.string())
      .describe("Slugs of the domain's workflows the caller may read, as listed in the briefing."),
    workflows_omitted: z.number().int(),
    connectors: z
      .array(z.string())
      .describe("Slugs of the domain's connectors the caller may read, as listed in the briefing."),
    connectors_omitted: z.number().int(),
    proposed_candidates: z.number().int(),
  })
  .openapi("AgentBriefingResponse");

const AgentDomainsResponse = z
  .object({
    domains: z.array(z.string()),
    from_prompt: z.array(z.string()),
    from_repo: z.array(z.string()),
  })
  .openapi("AgentDomainsResponse");

const domainsRoute = createRoute({
  method: "get",
  path: "/v1/agent/domains",
  tags: ["agent"],
  summary: "Resolve which known domains a prompt or repository is about",
  description:
    "Deterministic: a known domain (a `domain:<slug>` tag on an active skill or knowledge " +
    "source) matches when every part of its slug appears as a word in the prompt or the " +
    "repository hint. Coding-agent hooks use it to brief only what a turn is about.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        prompt: z.string().max(DOMAIN_PROMPT_MAX_CHARS).optional(),
        repo: z.string().max(DOMAIN_REPO_MAX_CHARS).optional(),
      })
      .openapi("AgentDomainsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AgentDomainsResponse } } },
  },
});

const briefingRoute = createRoute({
  method: "get",
  path: "/v1/agent/briefing",
  tags: ["agent"],
  summary: "Domain-scoped session briefing for external coding agents",
  description:
    "Returns a budgeted markdown grounding block for the requested domains: " +
    "prescriptive conventions (active skills tagged `domain:<slug>`), a knowledge " +
    "index, the domain's workflows and connectors (category or slug prefix equals the " +
    "domain), and the search-first grounding rule. Intended for coding-agent hooks.",
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

async function canReadKnowledge(db: Db, principal: ResolvedPrincipal): Promise<boolean> {
  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "knowledge:read",
    quiet: true,
  });
  return decision.allow;
}

async function catalogVisibility(
  db: Db,
  principal: ResolvedPrincipal,
  permission: "workflow:read" | "connector:read",
  resource_type: "workflow" | "connector",
): Promise<((id: string) => boolean) | null> {
  const access = await resourceAccess(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission,
    resource_type,
    quiet: true,
  });
  return access.any ? access.allows : null;
}

export function registerAgentBriefingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/agent/briefing", requirePermission("skill:read"));
  app.use("/v1/agent/domains", requirePermission("skill:read"));

  app.openapi(domainsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const known = await listKnownDomains(
      principal.tenant_id,
      { include_knowledge: await canReadKnowledge(db, principal) },
      db,
    );
    return c.json(resolveDomains({ prompt: q.prompt, repo_hint: q.repo, known }), 200);
  });

  app.openapi(briefingRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");

    const domains = [...new Set(q.domains.split(",").map((d) => d.trim()))].filter(Boolean);
    if (domains.length === 0 || domains.some((d) => !DOMAIN_SLUG_RE.test(d))) {
      throw new BadRequestError("domains must be comma-separated lowercase slugs (a-z, 0-9, -, _)");
    }

    const [includeKnowledge, workflowVisible, connectorVisible] = await Promise.all([
      canReadKnowledge(db, principal),
      catalogVisibility(db, principal, "workflow:read", "workflow"),
      catalogVisibility(db, principal, "connector:read", "connector"),
    ]);

    const result = await buildAgentBriefing({
      tenant_id: principal.tenant_id,
      domains,
      budget_tokens: q.budget_tokens ?? DEFAULT_BRIEFING_BUDGET_TOKENS,
      include_knowledge_index: includeKnowledge,
      workflow_visible: workflowVisible,
      connector_visible: connectorVisible,
      db,
    });
    return c.json(result, 200);
  });
}
