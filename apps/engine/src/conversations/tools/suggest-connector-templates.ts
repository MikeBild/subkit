import { z } from "@hono/zod-openapi";

import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { log } from "../../logging/logger.ts";
import {
  allowedTemplateAuthTypes,
  inferTemplateRequiredFields,
} from "../connector-template-intelligence.ts";
import { suggestConnectorTemplatesHybrid } from "../connector-template-vector.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).default(5),
  })
  .openapi("SuggestConnectorTemplatesToolInput");

export const suggestConnectorTemplatesTool: ConversationTool = {
  name: "suggest_connector_templates",
  description:
    "Suggest optional connector templates that match the user's system or vendor. Use this when a template might accelerate setup, but do not force the user to pick one.",
  inputSchema,
  category: "tenant_read",
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const ranked = await suggestConnectorTemplatesHybrid({
      query: args.query,
      limit: args.limit,
      templates: resolvedTemplates.map((entry) => entry.template),
    });
    const templates = ranked.map(({ template, score }) => {
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
      };
    });
    // Retrieval-quality signal for the evidence process — the third
    // (template-matching) retrieval path. No FTS/stemming here, so this
    // is the channel the probe set most expects to miss on morphology.
    log.connectorTemplates.suggested({
      tenant_id: ctx.tenant_id,
      query_length: args.query.length,
      hit_count: templates.length,
      top_match_id: templates[0]?.slug ?? null,
      top_rank: templates[0]?.score ?? null,
      limit: args.limit,
    });
    return {
      ok: true,
      data: {
        query: args.query,
        templates,
        suggested: templates.length > 0,
      },
    };
  },
};
