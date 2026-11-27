import { z } from "@hono/zod-openapi";
import { withMcpConfigDefaults } from "../../connectors/config-schemas.ts";
import type {
  OptionalAuthScheme,
  RecognizedAuth,
} from "../../connectors/discovery/recognize-auth.ts";
import {
  optionalAuthSchemes,
  recognizeAuthFromSchemes,
} from "../../connectors/discovery/recognize-auth.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { classifyLocalTarget } from "../../connectors/local-egress.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { matchTemplatesByUrl } from "../../connectors/template-url-match.ts";
import { DriverEnum } from "../../connectors/types.ts";
import { logger } from "../../logging/index.ts";
import { withConnectorDraft } from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import {
  allowedTemplateAuthTypes,
  defaultTemplateAuthType,
  inferAuthTypeFromDescription,
  inferTemplateRequiredFields,
  pickBestConnectorTemplate,
  shouldAutoSelectConnectorTemplate,
} from "../connector-template-intelligence.ts";
import { detectLocalCommand, literalCommandLine, splitShellWords } from "../local-command.ts";
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
      .enum(["none", "header", "query", "bearer", "basic", "oauth2", "aws_sigv4", "signed_jwt"])
      .optional(),
    force_new: z
      .boolean()
      .optional()
      .describe(
        "Set true only when the operator explicitly wants a SEPARATE connector on a base_url that already has one (e.g. a distinct credential scope). Skips URL reuse and mints an independent draft.",
      ),
    transport: z
      .enum(["http", "sse", "stdio"])
      .optional()
      .describe(
        "MCP only. Inferred when omitted: stdio when a command is given, sse when the base_url path ends in /sse, otherwise http.",
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "MCP stdio: the local command the user asked to start, e.g. `docker mcp gateway run` or `npx @playwright/mcp`. Given as one line it is split into program and arguments without a shell; pipes, redirects and $-expansion are refused. A person must allow it before it runs.",
      ),
    args: z
      .array(z.string())
      .optional()
      .describe("MCP stdio: program arguments when command holds only the program."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("MCP stdio: non-secret environment variables. Never secrets."),
    cwd: z.string().min(1).optional().describe("MCP stdio: the working folder."),
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
    const reuseEnvelope = await findReusableConnectorByUrl({
      tenant_id: ctx.tenant_id,
      environment: args.environment,
      base_url: args.base_url,
      ...(args.driver ? { driver: args.driver } : {}),
      ...(args.force_new ? { force_new: true } : {}),
      db: ctx.db,
    });
    if (reuseEnvelope) {
      return { ok: true, data: reuseEnvelope };
    }
    const commandPlan = resolveLocalCommandPlan(args);
    if (commandPlan && !commandPlan.ok) {
      return {
        ok: false,
        error_code: "invalid_local_command",
        message: `The local command was not accepted: ${commandPlan.reason}. Give one program with its arguments, e.g. "docker mcp gateway run" or "npx @playwright/mcp@latest". SubKit starts it directly, without a shell.`,
        next_best_actions: ["ask_user_text", "start_connector_from_description"],
      };
    }
    const wantsMcp =
      args.driver === "mcp" ||
      (args.driver === undefined && (commandPlan !== null || mentionsMcpEndpoint(args)));
    const mcpTransport: "http" | "sse" | "stdio" =
      args.transport ??
      (commandPlan ? "stdio" : /\/sse\/?$/i.test(urlPath(args.base_url)) ? "sse" : "http");
    const isStdio = wantsMcp && mcpTransport === "stdio";
    const inferredDriver =
      args.driver ??
      (wantsMcp
        ? "mcp"
        : args.dsn
          ? "postgres"
          : /^sftp:\/\//i.test(args.base_url ?? "")
            ? "sftp"
            : /graphql/i.test(args.base_url ?? "") || /graphql/i.test(args.description ?? "")
              ? "graphql"
              : /\bs3\b|\bbucket\b|\bobject storage\b/i.test(args.description ?? "")
                ? "s3"
                : "http");
    const descriptionForMatching = [args.name, args.description]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ");
    const resolvedTemplates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);

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
      !isStdio &&
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
    const urlPickedTemplate =
      urlMatchedAllowed && urlMatched && template?.slug === urlMatched.template.slug;
    const resolvedDescription = args.description ?? template?.description;
    const suppliedBaseUrl = args.base_url ?? null;
    const templateBaseUrl = template?.base_url ?? null;
    const baseUrlDisagrees =
      template !== null &&
      templateBaseUrl !== null &&
      suppliedBaseUrl !== null &&
      normalizeUrl(suppliedBaseUrl) !== normalizeUrl(templateBaseUrl);
    const baseUrlBoundFromTemplate =
      baseUrlDisagrees && sameUrlHost(suppliedBaseUrl ?? "", templateBaseUrl ?? "");
    const resolvedBaseUrl = isStdio
      ? undefined
      : baseUrlBoundFromTemplate
        ? (templateBaseUrl ?? undefined)
        : (args.base_url ?? template?.base_url);
    const localTarget = resolvedBaseUrl ? classifyLocalTarget(resolvedBaseUrl) : null;
    const defaultsToNoAuth = isStdio || localTarget !== null;
    const chainedAuthType: string | null = urlPickedTemplate
      ? template.auth_type
      : (args.auth_type ??
        inferAuthTypeFromDescription(args.description) ??
        (template && !defaultsToNoAuth ? defaultTemplateAuthType(template) : null));

    let recognizedAuth: RecognizedAuth | null = null;
    let discoveredOptionalSchemes: OptionalAuthScheme[] = [];
    let discoveredLocalHint: RecognizedAuth | null = null;
    if (!template && !chainedAuthType && inferredDriver === "http" && resolvedBaseUrl) {
      try {
        const actor_type = ctx.principal?.kind ?? ctx.engineClient.context.actor_type;
        const out = await runDiscoveryCached(
          {
            db: ctx.db,
            tenant_id: ctx.tenant_id,
            ...(actor_type ? { actor_type } : {}),
            actor_id: ctx.actor_id,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          },
          { base_url: resolvedBaseUrl, force_refresh: false },
        );
        recognizedAuth = recognizeAuthFromSchemes(out.result.auth_schemes);
        discoveredOptionalSchemes = optionalAuthSchemes(out.result.auth_schemes);
        if (defaultsToNoAuth && recognizedAuth && recognizedAuth.auth_type !== "oauth2") {
          discoveredLocalHint = recognizedAuth;
          recognizedAuth = null;
        }
      } catch (err) {
        logger.warn({
          module: "conversation_tool",
          action: "start_connector_from_description.discovery_failed",
          tenant_id: ctx.tenant_id,
          base_url: resolvedBaseUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const discoveryWasSource = !chainedAuthType && recognizedAuth !== null;
    const auth_type: import("../../connectors/index.ts").AuthType =
      (chainedAuthType as import("../../connectors/index.ts").AuthType | null) ??
      recognizedAuth?.auth_type ??
      "none";

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

    if (inferredDriver === "mcp") {
      seedConfig.mcp = {
        transport: mcpTransport,
        ...(isStdio && commandPlan?.ok
          ? {
              command: commandPlan.command,
              args: commandPlan.args,
              ...(args.env && Object.keys(args.env).length > 0 ? { env: args.env } : {}),
              ...(args.cwd ? { cwd: args.cwd } : {}),
            }
          : {}),
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
          ...(localTarget ? { local_target: localTarget } : {}),
          ...(isStdio && commandPlan?.ok
            ? {
                local_command: {
                  command_line: literalCommandLine({
                    command: commandPlan.command,
                    args: commandPlan.args,
                    env: {},
                    env_names: [],
                    env_secret_names: [],
                    cwd: null,
                  }),
                  needs_person_confirmation: true,
                  note: "probe_connector_draft asks the person to allow this command before it starts. Do not tell the user it is allowed until that answer arrives.",
                },
              }
            : {}),
          ...(discoveredOptionalSchemes.length > 0
            ? { optional_auth_schemes: discoveredOptionalSchemes }
            : {}),
          ...(discoveredLocalHint
            ? {
                discovered_auth_hint: {
                  auth_type: discoveredLocalHint.auth_type,
                  scheme_name: discoveredLocalHint.scheme_name,
                  note: "Local target: the draft starts without sign-in. Switch auth_type only if the probe returns 401.",
                },
              }
            : {}),
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

type LocalCommandPlan =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

function resolveLocalCommandPlan(args: {
  driver?: string | undefined;
  base_url?: string | undefined;
  transport?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  name: string;
  description?: string | undefined;
}): LocalCommandPlan | null {
  if (args.driver !== undefined && args.driver !== "mcp") return null;
  if (args.command !== undefined) {
    if (args.args !== undefined) return { ok: true, command: args.command, args: args.args };
    const split = splitShellWords(args.command);
    if (!split.ok) return split;
    const [command, ...rest] = split.words;
    return command
      ? { ok: true, command, args: rest }
      : { ok: false, reason: "the command is empty" };
  }
  if (args.base_url || (args.transport !== undefined && args.transport !== "stdio")) return null;
  const detected = detectLocalCommand(args.description) ?? detectLocalCommand(args.name);
  if (!detected) return null;
  const split = splitShellWords(detected);
  if (!split.ok) return split;
  const [command, ...rest] = split.words;
  return command ? { ok: true, command, args: rest } : null;
}

function urlPath(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function mentionsMcpEndpoint(args: {
  base_url?: string | undefined;
  transport?: string | undefined;
  name: string;
  description?: string | undefined;
}): boolean {
  if (args.transport !== undefined) return true;
  if (/\/(?:mcp|sse)\/?$/i.test(urlPath(args.base_url))) return true;
  return /\bmcp\b/i.test(`${args.name} ${args.description ?? ""}`);
}

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
