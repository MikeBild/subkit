import { z } from "@hono/zod-openapi";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { matchTemplatesByUrl } from "../../connectors/template-url-match.ts";
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
    auth_type: z
      .enum(["none", "header", "query", "bearer", "basic", "oauth2", "aws_sigv4"])
      .optional(),
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
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);

    // Prefer URL-pattern match when a URL is supplied — text matching
    // gets fooled by descriptions like "AWS AppSync GraphQL" picking up
    // generic "graphql" templates that hardcode `auth_type=header`,
    // when the URL clearly identifies a Cognito-fronted AppSync API
    // and we have a dedicated `appsync-cognito` template.
    //
    // When multiple templates share the same url_pattern (AppSync has
    // both `appsync-cognito` and `appsync-iam`), bias selection by the
    // LLM-supplied `auth_type` hint when it's compatible with one of
    // them; otherwise pick the first match (alphabetical tie-break in
    // `matchTemplatesByUrl`). The hint may also be wrong — the LLM
    // tends to guess SigV4 for any `appsync-api.*.amazonaws.com` host
    // even when the operator says "I have username and password" —
    // so when the hint disagrees with what URL match finds, URL match
    // still wins (the operator's URL is ground truth, the LLM hint
    // is a guess).
    const urlMatches = args.base_url
      ? matchTemplatesByUrl(
          args.base_url,
          5,
          resolvedTemplates.map((entry) => entry.template),
        )
      : [];
    const urlMatchedByAuthHint = args.auth_type
      ? (urlMatches.find((m) => allowedTemplateAuthTypes(m.template).includes(args.auth_type!)) ??
        null)
      : null;
    const urlMatched = urlMatchedByAuthHint ?? urlMatches[0] ?? null;
    const urlMatchedAllowed = urlMatched !== null;

    const bestTemplate = pickBestConnectorTemplate(
      descriptionForMatching,
      inferredDriver,
      resolvedTemplates.map((entry) => entry.template),
    );
    const textMatchedAllowed =
      bestTemplate &&
      shouldAutoSelectConnectorTemplate({
        template: bestTemplate.template,
        score: bestTemplate.score,
        name: args.name,
        ...(args.description ? { description: args.description } : {}),
      }) &&
      (!args.auth_type || allowedTemplateAuthTypes(bestTemplate.template).includes(args.auth_type));

    const resolvedTemplate = urlMatchedAllowed
      ? (resolvedTemplates.find((entry) => entry.template.slug === urlMatched.template.slug) ??
        null)
      : textMatchedAllowed
        ? (resolvedTemplates.find((entry) => entry.template.slug === bestTemplate!.template.slug) ??
          null)
        : null;
    const template = resolvedTemplate?.template ?? null;
    // When URL match selects the template, the template's primary
    // `auth_type` is authoritative — the LLM's `args.auth_type` is just
    // a guess that gets it wrong for AppSync (Cognito → "header"
    // assumption was the bug in session bb31c50b). For text matches
    // and unmatched drafts the LLM hint still wins.
    const urlPickedTemplate =
      urlMatchedAllowed && urlMatched && template?.slug === urlMatched.template.slug;
    const auth_type = urlPickedTemplate
      ? template.auth_type
      : (args.auth_type ??
        inferAuthTypeFromDescription(args.description) ??
        (template ? defaultTemplateAuthType(template) : "none"));
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
      template_slug: template?.slug ?? null,
      template_name: template?.name ?? null,
      template_source: resolvedTemplate?.source ?? null,
    };
    const validation = validateConnectorDraft(
      connector,
      template ? [template] : resolvedTemplates.map((entry) => entry.template),
    );
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
            template_slug: connector.template_slug ?? null,
            template_name: connector.template_name ?? null,
            template_source: connector.template_source ?? null,
            validation,
          },
          validation,
          matched_template: template
            ? {
                slug: template.slug,
                name: template.name,
                score:
                  urlMatched && template.slug === urlMatched.template.slug
                    ? urlMatched.score
                    : (bestTemplate?.score ?? 0),
                match_kind:
                  urlMatched && template.slug === urlMatched.template.slug
                    ? ("url" as const)
                    : ("text" as const),
                required_fields: inferTemplateRequiredFields(template),
              }
            : null,
        },
      }),
    };
  },
};
