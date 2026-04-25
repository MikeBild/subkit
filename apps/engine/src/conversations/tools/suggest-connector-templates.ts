import { z } from "@hono/zod-openapi";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import {
  allowedTemplateAuthTypes,
  inferTemplateRequiredFields,
  suggestConnectorTemplates,
} from "../connector-template-intelligence.ts";
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
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const templates = suggestConnectorTemplates({
      query: args.query,
      limit: args.limit,
      templates: resolvedTemplates.map((entry) => entry.template),
    }).map(({ template, score }) => {
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
