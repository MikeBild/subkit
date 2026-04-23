import { z } from "@hono/zod-openapi";
import { getBuiltinTemplate } from "../../connectors/templates.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import {
  allowedTemplateAuthTypes,
  defaultTemplateAuthType,
  inferTemplateRequiredFields,
} from "../connector-template-intelligence.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
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
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "unknown_template",
          message: `unknown template slug: ${args.template_slug}`,
          recommended_mode: "connector",
          next_best_actions: ["suggest_connector_templates", "start_connector_from_description"],
        }),
      };
    }
    const connector = {
      name: args.name ?? template.name,
      slug: template.slug,
      driver: template.driver,
      environment: args.environment,
      base_url: template.base_url,
      auth_type: defaultTemplateAuthType(template),
      config: {},
      description: template.description,
      template_id: template.slug,
      template_name: template.name,
      docs: template.ingestion_url ? [template.ingestion_url] : [],
      latest_probe: null,
      saved_connector_id: null,
    } as const;
    const validation = validateConnectorDraft(connector);
    const nextDraft = withConnectorDraft(
      ctx.getDraft(),
      { ...connector, validation },
      "connector_started_from_template",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "connector",
        extra: {
          connector: {
            name: connector.name,
            slug: connector.slug,
            driver: connector.driver,
            environment: connector.environment,
            auth_type: connector.auth_type,
            template_id: connector.template_id,
            allowed_auth_types: allowedTemplateAuthTypes(template),
            required_fields: inferTemplateRequiredFields(template),
            validation,
          },
          validation,
        },
      }),
    };
  },
};
