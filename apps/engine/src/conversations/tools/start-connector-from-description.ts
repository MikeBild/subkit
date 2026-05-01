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
import { findReusableConnectorByUrl } from "./connector-reuse.ts";
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
    // Reuse-existing-saved-connector: if the operator pasted a URL
    // that already maps to a saved connector in the same environment,
    // surface it instead of creating a new draft. Pre-fix the LLM
    // would call this tool with `name: "AWS AppSync Discovery"`,
    // generate a brand-new slug `aws-appsync-discovery`, and lose
    // the working `aws-appsync-graphql` connector + cached credential.
    // The user then re-typed credentials. This dedup keeps the prior
    // session's work — same pattern as the reference impl's
    // `findSystem(url)` short-circuit.
    const reuseEnvelope = await findReusableConnectorByUrl({
      tenant_id: ctx.tenant_id,
      environment: args.environment,
      base_url: args.base_url,
      ...(args.driver ? { driver: args.driver } : {}),
      db: ctx.db,
    });
    if (reuseEnvelope) {
      return { ok: true, data: reuseEnvelope };
    }
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
    // both `appsync-cognito` and `appsync-iam`), pick the BEST URL
    // match by score; if multiple templates TIE at the top score, use
    // the LLM-supplied `auth_type` hint to disambiguate among them
    // only — the hint never pulls a strictly-lower-score URL match in
    // front of the best. The hint is a guess (LLM frequently picks
    // SigV4 for any `appsync-api.*.amazonaws.com` host); a tie among
    // top URL matches is exactly when the hint adds signal, and
    // outside of ties the operator's URL is ground truth.
    const urlMatches = args.base_url
      ? matchTemplatesByUrl(
          args.base_url,
          5,
          resolvedTemplates.map((entry) => entry.template),
        )
      : [];
    const bestUrlMatch = urlMatches[0] ?? null;
    const topTies =
      bestUrlMatch !== null ? urlMatches.filter((m) => m.score === bestUrlMatch.score) : [];
    const urlMatchedByAuthHint =
      args.auth_type && topTies.length > 1
        ? (topTies.find((m) => allowedTemplateAuthTypes(m.template).includes(args.auth_type!)) ??
          null)
        : null;
    const urlMatched = urlMatchedByAuthHint ?? bestUrlMatch;
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
    // `config.oauth` is NOT seeded from the URL-matched template here.
    // The draft is auth-shape-agnostic until the operator picks an auth
    // path:
    //   • auth_type === "oauth2" → the LLM is steered to call
    //     `authenticate_oauth` after save. The OAuth2 client reads the
    //     template's oauth metadata from the snapshot at mint time
    //     (resolveConnectorOAuthConfig falls back to the snapshot when
    //     config.oauth is absent), so no draft-time seed is needed.
    //   • bearer / header / basic / aws_sigv4 / none → the operator
    //     supplies a credential via `ask_user_form`; no oauth config
    //     ever lands on the draft.
    // Seeding oauth into a bearer draft (the pre-fix behaviour) caused
    // strict-mode connector_config_invalid at save time — see session
    // 18467df2.
    const seedConfig: Record<string, unknown> = {};
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
      config: seedConfig,
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
            ...(connector.config && Object.keys(connector.config).length > 0
              ? { config: connector.config }
              : {}),
            template_slug: connector.template_slug ?? null,
            template_name: connector.template_name ?? null,
            template_source: connector.template_source ?? null,
            validation,
          },
          next_phase:
            connector.auth_type === "oauth2"
              ? {
                  phase: "authenticate_connector",
                  next_suggested_tool: "authenticate_oauth",
                  hint: "After save_connector_draft, call authenticate_oauth to start the authorization-code flow. The connector's saved template_snapshot already carries the oauth endpoints — no manual config needed.",
                }
              : connector.auth_type === "none"
                ? {
                    phase: "test_connector",
                    next_suggested_tool: "probe_connector_draft",
                    hint: "No credential needed. Probe the draft to verify base_url, then save.",
                  }
                : {
                    phase: "authenticate_connector",
                    next_suggested_tool: "ask_user_form",
                    hint: `Collect the operator's credential for auth_type=${connector.auth_type} (token / api key / username+password) via ask_user_form, then save_connector_draft binds it atomically with the connector.`,
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
