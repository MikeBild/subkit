import { z } from "@hono/zod-openapi";
import { parseAtlassianCloudResourceUrl } from "../../connectors/atlassian-tinyui.ts";
import { parseNotionResourceUrl } from "../../connectors/notion-page-id.ts";
import { baseUrlHost, compareConnectorOverlap } from "../../connectors/overlap.ts";
import { listConnectors } from "../../connectors/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { matchTemplatesByUrl } from "../../connectors/template-url-match.ts";
import {
  allowedTemplateAuthTypes,
  inferTemplateRequiredFields,
} from "../connector-template-intelligence.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    url: z.string().min(1),
    limit: z.number().int().positive().max(5).default(3),
  })
  .openapi("MatchConnectorTemplateByUrlToolInput");

export const matchConnectorTemplateByUrlTool: ConversationTool = {
  name: "match_connector_template_by_url",
  description:
    "Match a raw API URL against the connector template catalogue via url_pattern regex. Returns the top N candidates with their setup guidance, credential hints, and capabilities. Complement to `suggest_connector_templates` (text-based).",
  use_case:
    "Call this as soon as the operator pastes a concrete URL like https://api.stripe.com/v1/charges — before any manual connector setup.",
  example_input: { url: "https://api.stripe.com/v1/charges", limit: 3 },
  important_notes: [
    "Top-level `resolved_resource` is set when the URL is an Atlassian Cloud or Notion resource.",
    "`resolved_resource` shapes: `{ kind: 'confluence_tinyui', short, page_id }` (page_id is null when the shortlink fails to decode); `{ kind: 'confluence_page', page_id }`; `{ kind: 'jira_issue', key }`; `{ kind: 'notion_page', page_id }` (canonical dashed UUID extracted from the pasted Notion URL — pass it straight into the recipe's `page_id` field, do NOT author a URL-parsing transform).",
    "Use the `resolved_resource` id when building the first request step so the dry-run hits the real resource — do NOT probe the API to discover a value the matcher already gave you.",
    "Each `matches[].existing_connector_candidates[]` entry is a saved connector on this tenant that already serves the URL host.",
    "Reuse-candidate scoring: driver + base_url_host + auth_type, score 1-3 (count of matching dimensions).",
    "`reuse_recommendation: 'exact_match_reuse'` (score 3) — propose reuse unchanged. Do NOT create a new draft.",
    "`reuse_recommendation: 'reuse_with_host_override'` (score 2, auth_type matches) — propose forking or adjusting the base_url. Confirm with the user before either.",
    "`reuse_recommendation: 'reuse_after_auth_check'` (score 2, driver+host match but auth_type differs) — surface the conflict to the user before drafting.",
    "Tenant-scoped: only connectors on the caller's tenant appear in `existing_connector_candidates` (foreign-tenant rows are filtered out by `listConnectors`).",
    "`resolved_resource` is decoded locally and carries no tenant data.",
    "`tenant_connectors_truncated: true` is set when the tenant has more than 500 active connectors. Ask the user to narrow the search (vendor name, environment) so the reuse check can be exhaustive.",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const matches = matchTemplatesByUrl(
      args.url,
      args.limit,
      resolvedTemplates.map((entry) => entry.template),
    ).map(({ template, score, matched_segment }) => {
      const resolved = resolvedTemplates.find((entry) => entry.template.slug === template.slug)!;
      return {
        slug: template.slug,
        name: template.name,
        driver: template.driver,
        source: resolved.source,
        version: template.version,
        auth_type: template.auth_type,
        allowed_auth_types: allowedTemplateAuthTypes(template),
        required_fields: inferTemplateRequiredFields(template),
        description: template.description,
        setup_instructions: template.setup_instructions,
        credential_hints: template.credential_hints,
        keywords: template.keywords,
        capabilities: template.capabilities,
        default_skill: template.default_skill,
        score,
        matched_segment,
      };
    });
    // Fix 3 — Atlassian tinyui / direct-page / Jira-issue resolver. When
    // the URL is an Atlassian Cloud resource, decode the resource id so
    // the LLM can build the workflow's first request step against the
    // real resource on the FIRST dry-run (session 0498925e cost 3+
    // probe round-trips to discover that /wiki/x/y4ozBQ → page 87263947).
    // Notion appends the page id as a bare 32-hex run to the slug, which an
    // LLM-authored normalise transform tends to 404 on (conversation
    // 661e7ad1). Resolve it here so the LLM passes a canonical page_id into
    // the recipe and the first dry-run hits the real page.
    const resolved_resource =
      parseAtlassianCloudResourceUrl(args.url) ?? parseNotionResourceUrl(args.url);

    // Adoption E — inline "you already have X" hint. List the tenant's
    // existing connectors on the same URL host AND score the structural
    // overlap (driver + base_url_host + auth_type) against each
    // template match's expected shape. The LLM gets reuse candidates in
    // the same response and proposes reuse BEFORE drafting a duplicate.
    //
    // `listConnectors` returns the complete catalog by default (safety
    // bound 1000) plus the exact `total`, so the truncation signal is
    // ground truth — `total > rows.length` — instead of a "did we hit
    // the cap?" heuristic. `tenant_connectors_truncated` tells the LLM
    // the scan missed rows and it can ask the user to narrow the search.
    const urlHost = baseUrlHost(args.url);
    const tenantConnectorList = urlHost
      ? await listConnectors(ctx.tenant_id, {}, ctx.db)
      : { rows: [], total: 0 };
    const tenantConnectors = tenantConnectorList.rows;
    const tenant_connectors_truncated = tenantConnectorList.total > tenantConnectors.length;
    // For each template match, run the overlap scorer against the
    // tenant's connectors and attach the top reuse candidate(s). The
    // template's driver + auth_type drives the proposed shape; the URL
    // host is the proposed base_url_host.
    const matchesWithReuse = matches.map((match) => {
      const reuseCandidates = compareConnectorOverlap(
        tenantConnectors,
        {
          driver: match.driver,
          base_url: args.url,
          auth_type: match.auth_type,
        },
        { minScore: 2 },
      ).map((m) => ({
        connector_id: m.connector.id,
        connector_slug: m.connector.slug,
        connector_name: m.connector.display_name,
        score: m.score,
        matched_dimensions: m.dimensions,
        reuse_recommendation:
          m.score === 3
            ? "exact_match_reuse"
            : m.dimensions.includes("auth_type")
              ? "reuse_with_host_override"
              : "reuse_after_auth_check",
      }));
      return { ...match, existing_connector_candidates: reuseCandidates };
    });

    return {
      ok: true,
      data: {
        url: args.url,
        matched: matchesWithReuse.length > 0,
        ...(resolved_resource ? { resolved_resource } : {}),
        ...(tenant_connectors_truncated ? { tenant_connectors_truncated: true } : {}),
        matches: matchesWithReuse,
      },
    };
  },
};
