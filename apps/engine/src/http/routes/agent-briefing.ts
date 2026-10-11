import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  buildAgentBriefing,
  DEFAULT_BRIEFING_BUDGET_TOKENS,
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
import { DOMAIN_SLUG_RE } from "../../api/domain-slug.ts";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import type { Db } from "../../db/client.ts";
import { can, catalogVisibility, resourceAccess } from "../../rbac/index.ts";
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
    files: z.array(
      z.object({
        name: z.string(),
        slug: z.string().nullable(),
        category: z.string(),
        description: z.string().nullable(),
      }),
    ),
    files_omitted: z.number().int(),
    guides: z
      .array(z.string())
      .describe("Slugs of the skills that teach how to work with sk, listed for every domain."),
    proposed_candidates: z.number().int(),
    intake: z
      .object({
        collected: z.number().int().nonnegative(),
        reviewing: z.number().int().nonnegative(),
        proposals: z.number().int().nonnegative(),
      })
      .nullable()
      .describe(
        "Tenant-wide intake counts; null when the caller cannot read intake. Never includes clip content.",
      ),
  })
  .openapi("AgentBriefingResponse");

const AgentDomainsResponse = z
  .object({
    domains: z.array(z.string()),
    from_prompt: z.array(z.string()),
    from_repo: z.array(z.string()),
    from_folder: z.array(z.string()),
  })
  .openapi("AgentDomainsResponse");

const domainsRoute = createRoute({
  method: "post",
  path: "/v1/agent/domains",
  tags: ["agent"],
  summary: "Resolve which known domains a prompt, repository, or current folder is about",
  description:
    "Deterministic: prompt and repository matching use domain words; current-folder matching " +
    "uses its normalized basename as an exact shared catalog category. Coding-agent hooks use " +
    "it to brief only what a turn is about. Reads " +
    "only; the prompt travels in the body so it stays out of URLs and access logs.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              prompt: z.string().max(DOMAIN_PROMPT_MAX_CHARS).optional(),
              repo: z.string().max(DOMAIN_REPO_MAX_CHARS).optional(),
              folder: z
                .string()
                .max(DOMAIN_REPO_MAX_CHARS)
                .refine((value) => !value.includes("/") && !value.includes("\\"), {
                  message: "folder must be a basename, not a path",
                })
                .optional(),
            })
            .openapi("AgentDomainsBody"),
        },
      },
    },
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
    "domain), readable file metadata without file contents, and the search-first grounding " +
    "rule. Intended for coding-agent hooks.",
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

async function fileVisibility(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<Awaited<ReturnType<typeof resourceAccess>>> {
  return resourceAccess(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "file:read",
    resource_type: "file",
    quiet: true,
  });
}

export function registerAgentBriefingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/agent/briefing", requirePermission("skill:read"));
  app.use("/v1/agent/domains", requirePermission("skill:read"));

  app.openapi(domainsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const [includeKnowledge, workflowVisible, connectorVisible, fileAccess] = await Promise.all([
      canReadKnowledge(db, principal),
      catalogVisibility(db, principal, "workflow:read", "workflow"),
      catalogVisibility(db, principal, "connector:read", "connector"),
      fileVisibility(db, principal),
    ]);
    const known = await listKnownDomains(
      principal.tenant_id,
      {
        include_knowledge: includeKnowledge,
        workflow_visible: workflowVisible,
        connector_visible: connectorVisible,
        file_visible: fileAccess.any ? fileAccess.allows : null,
        file_tenant_wide: fileAccess.tenantWide.allow,
      },
      db,
    );
    return c.json(
      resolveDomains({
        prompt: body.prompt,
        repo_hint: body.repo,
        folder_hint: body.folder,
        known,
      }),
      200,
    );
  });

  app.openapi(briefingRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");

    const domains = [...new Set(q.domains.split(",").map((d) => d.trim()))].filter(Boolean);
    if (domains.length === 0 || domains.some((d) => !DOMAIN_SLUG_RE.test(d))) {
      throw new BadRequestError("domains must be comma-separated lowercase slugs (a-z, 0-9, -, _)");
    }

    const [includeKnowledge, workflowVisible, connectorVisible, fileAccess, intakeDecision] =
      await Promise.all([
        canReadKnowledge(db, principal),
        catalogVisibility(db, principal, "workflow:read", "workflow"),
        catalogVisibility(db, principal, "connector:read", "connector"),
        fileVisibility(db, principal),
        can(db, {
          tenant_id: principal.tenant_id,
          principal,
          permission: "intake:read",
          quiet: true,
        }),
      ]);

    const result = await buildAgentBriefing({
      tenant_id: principal.tenant_id,
      domains,
      budget_tokens: q.budget_tokens ?? DEFAULT_BRIEFING_BUDGET_TOKENS,
      include_knowledge_index: includeKnowledge,
      include_intake: intakeDecision.allow,
      workflow_visible: workflowVisible,
      connector_visible: connectorVisible,
      file_visible: fileAccess.any ? fileAccess.allows : null,
      file_tenant_wide: fileAccess.tenantWide.allow,
      db,
    });
    return c.json(result, 200);
  });
}
