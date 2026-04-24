import { z } from "@hono/zod-openapi";
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
  inputSchema,
  category: "tenant_read",
  async execute(_ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const matches = matchTemplatesByUrl(args.url, args.limit).map(
      ({ template, score, matched_segment }) => ({
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
      }),
    );
    return {
      ok: true,
      data: {
        url: args.url,
        matched: matches.length > 0,
        matches,
      },
    };
  },
};
