import { z } from "@hono/zod-openapi";
import { parseAtlassianCloudResourceUrl } from "../../connectors/atlassian-tinyui.ts";
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
    "Top-level `resolved_resource` is set when the URL is an Atlassian Cloud resource. Shapes: `{ kind: 'confluence_tinyui', short, page_id }` (page_id is null when the shortlink fails to decode), `{ kind: 'confluence_page', page_id }`, `{ kind: 'jira_issue', key }`. Use the resolved id when building the first request step so the dry-run hits the real resource.",
    "Each `matches[].existing_connector_candidates[]` entry is a saved connector on this tenant that already serves the URL host. Scored on driver + base_url_host + auth_type (1-3). `reuse_recommendation` is one of: `exact_match_reuse` (score 3 — propose reuse unchanged, do NOT create a new draft); `reuse_with_host_override` (score 2, auth_type matches — propose forking or adjusting the base_url, confirm with the user); `reuse_after_auth_check` (score 2, driver+host match but auth_type differs — surface the conflict to the user before drafting).",
    "Tenant-scoped: only connectors on the caller's tenant appear in `existing_connector_candidates` (foreign-tenant rows are filtered out by `listConnectors`). `resolved_resource` is decoded locally and carries no tenant data.",
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
    const resolved_resource = parseAtlassianCloudResourceUrl(args.url);

    // Adoption E — inline "you already have X" hint. List the tenant's
    // existing connectors on the same URL host AND score the structural
    // overlap (driver + base_url_host + auth_type) against each
    // template match's expected shape. The LLM gets reuse candidates in
    // the same response and proposes reuse BEFORE drafting a duplicate
    // (session 0498925e: the existing SI eMobility Jira basic-auth
    // connector serves both Jira and Confluence on the same host —
    // but the LLM only noticed AFTER proposing a new draft).
    // Use the canonical `listConnectors` service helper (capped at 500,
    // tenant-scoped, soft-deleted rows excluded) instead of a hand-rolled
    // select. `ConnectorView` already carries the `id / slug / display_name
    // / driver / auth_type / base_url` shape `compareConnectorOverlap`
    // expects, so the projection is implicit. Skipping the call when the
    // URL has no parseable host avoids a tenant scan for inputs like
    // "not-a-url".
    const urlHost = baseUrlHost(args.url);
    const tenantConnectors = urlHost ? await listConnectors(ctx.tenant_id, {}, ctx.db) : [];
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
        matches: matchesWithReuse,
      },
    };
  },
};
