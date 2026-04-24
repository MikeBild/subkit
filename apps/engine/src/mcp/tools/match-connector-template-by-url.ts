// MCP `match_connector_template_by_url` product tool.
//
// Stateless: no DB access required. Delegates to the URL-pattern regex
// matcher in connectors/template-url-match.ts. Available in all MCP
// modes (product / authoring / admin) so external agents can resolve a
// raw API URL to a connector template without starting a conversation.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { matchTemplatesByUrl } from "../../connectors/template-url-match.ts";
import {
  allowedTemplateAuthTypes,
  inferTemplateRequiredFields,
} from "../../conversations/connector-template-intelligence.ts";

export const MATCH_CONNECTOR_TEMPLATE_BY_URL_TOOL_NAME = "match_connector_template_by_url";

export const matchConnectorTemplateByUrlMcpTool: Tool = {
  name: MATCH_CONNECTOR_TEMPLATE_BY_URL_TOOL_NAME,
  description:
    "Match a raw API URL against the built-in connector template catalogue using url_pattern regex. Returns the top N candidates with setup guidance, credential hints, and capabilities.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The API base URL or a full endpoint URL to match (e.g. https://api.stripe.com/v1/charges).",
      },
      limit: {
        type: "number",
        description: "Maximum number of matches to return (1–5, default 3).",
        default: 3,
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export interface MatchConnectorTemplateByUrlArgs {
  url: string;
  limit?: number;
}

export interface MatchConnectorTemplateByUrlResult {
  url: string;
  matched: boolean;
  matches: Array<{
    slug: string;
    name: string;
    driver: string;
    auth_type: string;
    allowed_auth_types: string[];
    required_fields: string[];
    description: string;
    setup_instructions: string;
    credential_hints: unknown[];
    keywords: string[];
    capabilities: unknown;
    default_skill: string | null;
    score: number;
    matched_segment: string;
  }>;
}

export function handleMatchConnectorTemplateByUrl(
  args: MatchConnectorTemplateByUrlArgs,
): { ok: true; data: MatchConnectorTemplateByUrlResult } | { ok: false; data: { error: string } } {
  const url = args.url ?? "";
  const limit = Math.min(Math.max(1, args.limit ?? 3), 5);
  if (!url) {
    return { ok: false, data: { error: "url is required" } };
  }
  const matches = matchTemplatesByUrl(url, limit).map(({ template, score, matched_segment }) => ({
    slug: template.slug,
    name: template.name,
    driver: template.driver,
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
  }));
  return {
    ok: true,
    data: { url, matched: matches.length > 0, matches },
  };
}
