// URL → template matching:
//   GET /v1/connector-templates/match-url

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import {
  listResolvedConnectorTemplates,
  matchTemplatesByUrl,
  type ResolvedConnectorTemplate,
  type TemplateUrlMatch,
} from "../../../connectors/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { MatchUrlQuery, MatchUrlResponseSchema } from "./schemas.ts";

const matchUrlRoute = createRoute({
  method: "get",
  path: "/v1/connector-templates/match-url",
  tags: ["connectors"],
  summary: "Match a URL to connector templates by url_pattern regex",
  security: [{ bearerAuth: [] }],
  request: { query: MatchUrlQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MatchUrlResponseSchema } },
    },
  },
});

export function registerMatchUrlRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(matchUrlRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { url, limit } = c.req.valid("query");
    const resolvedTemplates = await listResolvedConnectorTemplates(db, principal.tenant_id);
    // invariant: matchTemplatesByUrl only returns slugs from the same input
    // list, so every match has a corresponding resolved template — but we
    // skip silently if the cross-reference ever drifts instead of crashing.
    const matches: Array<TemplateUrlMatch & { resolved: ResolvedConnectorTemplate }> =
      matchTemplatesByUrl(
        url,
        limit,
        resolvedTemplates.map((entry) => entry.template),
      ).flatMap((entry) => {
        const resolved = resolvedTemplates.find(
          (candidate) => candidate.template.slug === entry.template.slug,
        );
        return resolved ? [{ ...entry, resolved }] : [];
      });
    return c.json(
      {
        url,
        matched: matches.length > 0,
        matches: matches.map(({ template, score, matched_segment, resolved }) => ({
          slug: template.slug,
          name: template.name,
          driver: template.driver,
          source: resolved.source,
          version: template.version,
          score,
          matched_segment,
          description: template.description,
          setup_instructions: template.setup_instructions,
          credential_hints: template.credential_hints,
          keywords: template.keywords,
          capabilities: template.capabilities,
        })),
      },
      200,
    );
  });
}
