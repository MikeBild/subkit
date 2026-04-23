import { z } from "@hono/zod-openapi";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import {
  allowedTemplateAuthTypes,
  defaultTemplateAuthType,
  inferAuthTypeFromDescription,
  inferTemplateRequiredFields,
  pickBestConnectorTemplate,
  shouldAutoSelectConnectorTemplate,
} from "../connector-template-intelligence.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    driver: z.enum(["http", "postgres", "s3", "graphql"]).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]).optional(),
  })
  .openapi("StartConnectorFromDescriptionToolInput");

export const startConnectorFromDescriptionTool: ConversationTool = {
  name: "start_connector_from_description",
  description:
    "Start a connector draft directly from the user's description. Use this as the default path when the user did not explicitly choose a template.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const inferredDriver =
      args.driver ??
      (args.dsn
        ? "postgres"
        : /graphql/i.test(args.base_url ?? "") || /graphql/i.test(args.description ?? "")
          ? "graphql"
          : /\bs3\b|\bbucket\b|\bobject storage\b/i.test(args.description ?? "")
            ? "s3"
            : "http");
    const descriptionForMatching = [args.name, args.description]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
    const bestTemplate = pickBestConnectorTemplate(descriptionForMatching, inferredDriver);
    const template =
      bestTemplate &&
      shouldAutoSelectConnectorTemplate({
        template: bestTemplate.template,
        score: bestTemplate.score,
        name: args.name,
        ...(args.description ? { description: args.description } : {}),
      }) &&
      (!args.auth_type || allowedTemplateAuthTypes(bestTemplate.template).includes(args.auth_type))
        ? bestTemplate.template
        : null;
    const auth_type =
      args.auth_type ??
      inferAuthTypeFromDescription(args.description) ??
      (template ? defaultTemplateAuthType(template) : "none");
    const resolvedDescription = args.description ?? template?.description;
    const resolvedBaseUrl = args.base_url ?? template?.base_url;
    const connector: ConnectorDraftDocument = {
      name: args.name,
      slug: args.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64),
      driver: inferredDriver,
      environment: args.environment,
      ...(resolvedDescription ? { description: resolvedDescription } : {}),
      ...(resolvedBaseUrl ? { base_url: resolvedBaseUrl } : {}),
      ...(args.dsn ? { dsn: args.dsn } : {}),
      auth_type,
      config: {},
      docs: template?.ingestion_url ? [template.ingestion_url] : [],
      latest_probe: null,
      saved_connector_id: null,
      template_id: template?.slug ?? null,
      template_name: template?.name ?? null,
    };
    const validation = validateConnectorDraft(connector);
    const nextDraft = withConnectorDraft(
      ctx.getDraft(),
      { ...connector, validation },
      "connector_started_from_description",
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
            template_id: connector.template_id ?? null,
            template_name: connector.template_name ?? null,
            validation,
          },
          validation,
          matched_template:
            template && bestTemplate
              ? {
                  slug: template.slug,
                  name: template.name,
                  score: bestTemplate.score,
                  required_fields: inferTemplateRequiredFields(template),
                }
              : null,
        },
      }),
    };
  },
};
