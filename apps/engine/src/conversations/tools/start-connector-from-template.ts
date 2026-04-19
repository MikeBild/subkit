import { z } from "@hono/zod-openapi";
import { getBuiltinTemplate } from "../../connectors/templates.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    template_slug: z.string().min(1),
    environment: z.enum(["dev", "prod"]).default("dev"),
    name: z.string().min(1).optional(),
  })
  .openapi("StartConnectorFromTemplateToolInput");

export const startConnectorFromTemplateTool: ConversationTool = {
  name: "start_connector_from_template",
  description:
    "Start a connector draft from a built-in template. Use this only when the user wants the template; templates are optional accelerators.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const template = getBuiltinTemplate(args.template_slug);
    if (!template) {
      return { ok: false, data: { error: `unknown template slug: ${args.template_slug}` } };
    }
    const connector = {
      name: args.name ?? template.name,
      slug: template.slug,
      driver: template.driver,
      environment: args.environment,
      base_url: template.base_url,
      auth_type: template.auth_type,
      config: {},
      description: template.description,
      template_id: template.slug,
      template_name: template.name,
      docs: template.ingestion_url ? [template.ingestion_url] : [],
      latest_probe: null,
      saved_connector_id: null,
    } as const;
    const validation = validateConnectorDraft(connector);
    await ctx.setDraft(
      withConnectorDraft(
        ctx.getDraft(),
        { ...connector, validation },
        "connector_started_from_template",
      ),
    );
    return {
      ok: true,
      data: {
        connector: {
          name: connector.name,
          slug: connector.slug,
          driver: connector.driver,
          environment: connector.environment,
          auth_type: connector.auth_type,
          template_id: connector.template_id,
        },
        validation,
      },
    };
  },
};
