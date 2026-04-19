import { z } from "@hono/zod-openapi";
import type { ConnectorTemplate } from "../../connectors/templates.ts";
import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).default(5),
  })
  .openapi("SuggestConnectorTemplatesToolInput");

function scoreTemplate(template: ConnectorTemplate, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  if (template.slug.includes(q)) score += 8;
  if (template.name.toLowerCase().includes(q)) score += 8;
  if (template.description.toLowerCase().includes(q)) score += 4;
  if (template.category?.toLowerCase().includes(q)) score += 3;
  for (const tag of template.tags) {
    if (tag.toLowerCase().includes(q)) score += 2;
  }
  for (const token of q.split(/\s+/)) {
    if (!token) continue;
    if (template.slug.includes(token)) score += 3;
    if (template.name.toLowerCase().includes(token)) score += 3;
    if (template.description.toLowerCase().includes(token)) score += 1;
  }
  return score;
}

export const suggestConnectorTemplatesTool: ConversationTool = {
  name: "suggest_connector_templates",
  description:
    "Suggest optional connector templates that match the user's system or vendor. Use this when a template might accelerate setup, but do not force the user to pick one.",
  inputSchema,
  category: "tenant_read",
  async execute(_ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const templates = loadBuiltinTemplates()
      .map((template) => ({ template, score: scoreTemplate(template, args.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit)
      .map(({ template, score }) => ({
        slug: template.slug,
        name: template.name,
        driver: template.driver,
        auth_type: template.auth_type,
        description: template.description,
        setup_hint: template.setup_hint ?? null,
        default_skill: template.default_skill,
        score,
      }));
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
