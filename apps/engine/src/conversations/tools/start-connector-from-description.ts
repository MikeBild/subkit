import { z } from "@hono/zod-openapi";
import { withMcpConfigDefaults } from "../../connectors/config-schemas.ts";
import type { RecognizedAuth } from "../../connectors/discovery/recognize-auth.ts";
import { recognizeAuthFromSchemes } from "../../connectors/discovery/recognize-auth.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { matchTemplatesByUrl } from "../../connectors/template-url-match.ts";
import { DriverEnum } from "../../connectors/types.ts";
import { logger } from "../../logging/logger.ts";
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
import { buildAuthNextPhase, buildDraftMutationPayload } from "./authoring-contract.ts";
import { findReusableConnectorByUrl } from "./connector-reuse.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    driver: DriverEnum.optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z
      .enum(["none", "header", "query", "bearer", "basic", "oauth2", "aws_sigv4"])
      .optional(),
    force_new: z
      .boolean()
      .optional()
      .describe(
        "Set true only when the operator explicitly wants a SEPARATE connector on a base_url that already has one (e.g. a distinct credential scope). Skips URL reuse and mints an independent draft.",
      ),
  })
  .openapi("StartConnectorFromDescriptionToolInput");

export const startConnectorFromDescriptionTool: ConversationTool = {
  name: "start_connector_from_description",
  description:
    "Start a connector draft directly from the user's description. Use this as the default path when the user did not explicitly choose a template.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "connector",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    // Reuse-existing-saved-connector: if the operator pasted a URL
    // that already maps to a saved connector in the same environment,
    // surface it instead of creating a new draft. Pre-fix the LLM
    // would call this tool with `name: "AWS AppSync Discovery"`,
    // generate a brand-new slug `aws-appsync-discovery`, and lose
    // the working `aws-appsync-graphql` connector + cached credential.
    // The user then re-typed credentials. This dedup keeps the prior
    // session's work via a `findReusableConnectorByUrl` short-circuit.
    const reuseEnvelope = await findReusableConnectorByUrl({
      tenant_id: ctx.tenant_id,
      environment: args.environment,
      base_url: args.base_url,
      ...(args.driver ? { driver: args.driver } : {}),
      // `force_new` is the operator's explicit "I want a SEPARATE connector
      // on this URL" signal (e.g. a scope-isolated credential). A differing
      // name alone is the normal re-describe case and still reuses.
      ...(args.force_new ? { force_new: true } : {}),
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
        ).filter((match) => match.template.driver === inferredDriver)
      : [];
    const bestUrlMatch = urlMatches[0] ?? null;
    const topTies =
      bestUrlMatch !== null ? urlMatches.filter((m) => m.score === bestUrlMatch.score) : [];
    const authHint = args.auth_type;
    const urlMatchedByAuthHint =
      authHint && topTies.length > 1
        ? (topTies.find((m) => allowedTemplateAuthTypes(m.template).includes(authHint)) ?? null)
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
      : textMatchedAllowed && bestTemplate
        ? (resolvedTemplates.find((entry) => entry.template.slug === bestTemplate.template.slug) ??
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
    // Auth type precedence (highest to lowest):
    //   1. Template URL match — authoritative when a template was found.
    //   2. LLM-supplied args.auth_type hint.
    //   3. Inferred from description text.
    //   4. Template default (text-matched template).
    //   5. Discovered from the OpenAPI securitySchemes (only when no
    //      template matched, driver is http, and base_url is present).
    //   6. "none" (fallback).
    const resolvedDescription = args.description ?? template?.description;
    // Template base_url binding. A matched template's base_url is the
    // CANONICAL API root — when the LLM's guess sits on the same host,
    // the template wins (the guess is typically missing the version
    // path: conversation 68b5c87e guessed `/graphql` where the template
    // carried `/api/v2/graphql`, and the probe 404'd). When the hosts
    // differ the operator's URL is ground truth — wildcard-host
    // templates (self-hosted / tenant-subdomain instances) carry a
    // placeholder host that must never clobber a real instance URL.
    const suppliedBaseUrl = args.base_url ?? null;
    const templateBaseUrl = template?.base_url ?? null;
    const baseUrlDisagrees =
      template !== null &&
      templateBaseUrl !== null &&
      suppliedBaseUrl !== null &&
      normalizeUrl(suppliedBaseUrl) !== normalizeUrl(templateBaseUrl);
    const baseUrlBoundFromTemplate =
      baseUrlDisagrees && sameUrlHost(suppliedBaseUrl ?? "", templateBaseUrl ?? "");
    const resolvedBaseUrl = baseUrlBoundFromTemplate
      ? (templateBaseUrl ?? undefined)
      : (args.base_url ?? template?.base_url);
    const chainedAuthType: string | null = urlPickedTemplate
      ? template.auth_type
      : (args.auth_type ??
        inferAuthTypeFromDescription(args.description) ??
        (template ? defaultTemplateAuthType(template) : null));

    // Discovery fills an unresolved auth mode; known auth makes the network lookup redundant.
    let recognizedAuth: RecognizedAuth | null = null;
    if (!template && !chainedAuthType && inferredDriver === "http" && resolvedBaseUrl) {
      try {
        const out = await runDiscoveryCached(
          {
            db: ctx.db,
            tenant_id: ctx.tenant_id,
            actor_id: ctx.actor_id,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          },
          { base_url: resolvedBaseUrl, force_refresh: false },
        );
        recognizedAuth = recognizeAuthFromSchemes(out.result.auth_schemes);
      } catch (err) {
        // Discovery is best-effort; a missing spec or network error must
        // not block the connector draft from being created.
        logger.warn({
          module: "conversation_tool",
          action: "start_connector_from_description.discovery_failed",
          tenant_id: ctx.tenant_id,
          base_url: resolvedBaseUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Use discovered auth only when the existing chain produced no result.
    // Discovered recognition is a new deterministic source — it fires
    // only when the template/LLM/description chain yielded nothing.
    const discoveryWasSource = !chainedAuthType && recognizedAuth !== null;
    const auth_type: import("../../connectors/types.ts").AuthType =
      (chainedAuthType as import("../../connectors/types.ts").AuthType | null) ??
      recognizedAuth?.auth_type ??
      "none";

    // Seed `config.oauth` from discovered metadata when recognition fired
    // and the auth type resolved to oauth2. The OAuth2 client reads these
    // at mint/refresh time. `issuer_url` is required by OAuthEnrichmentSchema;
    // derive it from the origin of the resolved base URL.
    const seedConfig: Record<string, unknown> = {};
    if (
      auth_type === "oauth2" &&
      recognizedAuth?.auth_type === "oauth2" &&
      recognizedAuth.oauth &&
      resolvedBaseUrl
    ) {
      let origin: string;
      try {
        origin = new URL(resolvedBaseUrl).origin;
      } catch {
        origin = resolvedBaseUrl;
      }
      seedConfig.oauth = {
        issuer_url: origin,
        ...(recognizedAuth.oauth.authorization_endpoint
          ? { authorization_endpoint: recognizedAuth.oauth.authorization_endpoint }
          : {}),
        ...(recognizedAuth.oauth.token_endpoint
          ? { token_endpoint: recognizedAuth.oauth.token_endpoint }
          : {}),
        ...(recognizedAuth.oauth.scope ? { scope: recognizedAuth.oauth.scope } : {}),
        grant_type: recognizedAuth.oauth.grant_type,
        client_id: null,
      };
    }

    const effectiveConfig = withMcpConfigDefaults(inferredDriver, auth_type, seedConfig);
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
      config: effectiveConfig,
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
          next_phase: buildAuthNextPhase(connector.auth_type),
          validation,
          ...(discoveryWasSource && recognizedAuth
            ? {
                recognized_auth: {
                  auth_type: recognizedAuth.auth_type,
                  scheme_name: recognizedAuth.scheme_name,
                  source: "discovered_security_scheme" as const,
                },
              }
            : {}),
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
                // The canonical setup steps + credential shape travel
                // WITH the binding so the model never re-guesses them.
                setup_instructions: template.setup_instructions,
                credential_hints: template.credential_hints,
                template_base_url: template.base_url,
              }
            : null,
          ...(template && baseUrlDisagrees && suppliedBaseUrl && templateBaseUrl
            ? {
                base_url_conflict: {
                  supplied_base_url: suppliedBaseUrl,
                  template_base_url: templateBaseUrl,
                  bound_base_url: resolvedBaseUrl ?? suppliedBaseUrl,
                  overridden: baseUrlBoundFromTemplate,
                  note: baseUrlBoundFromTemplate
                    ? `Your base_url disagrees with template "${template.slug}" — the draft is bound to the template's canonical base_url (${templateBaseUrl}). If the supplied URL was intentional, set it back via update_connector_draft.`
                    : `Your base_url is on a different host than template "${template.slug}" (${templateBaseUrl}) — keeping your URL, since self-hosted / tenant-specific instances legitimately differ. Double-check the path against the template's setup_instructions.`,
                },
              }
            : {}),
        },
      }),
    };
  },
};

/** Strip trailing slashes so `…/api/` and `…/api` compare equal. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sameUrlHost(a: string, b: string): boolean {
  const originA = urlOrigin(a);
  return originA !== null && originA === urlOrigin(b);
}
