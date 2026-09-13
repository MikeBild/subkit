import { z } from "@hono/zod-openapi";

import { withMcpConfigDefaults } from "../../connectors/config-schemas.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { enrichConnectorFromTemplate } from "../../connectors/template-enrichment.ts";
import { resolveConnectorTemplate } from "../../connectors/template-resolver.ts";
import { logger } from "../../logging/logger.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import {
  allowedTemplateAuthTypes,
  inferTemplateRequiredFields,
} from "../connector-template-intelligence.ts";
import {
  buildAuthNextPhase,
  buildDraftMutationPayload,
  buildGateError,
} from "./authoring-contract.ts";
import { findReusableConnectorByUrl } from "./connector-reuse.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    template_slug: z.string().min(1),
    environment: z.enum(["dev", "prod"]).default("dev"),
    name: z.string().min(1).optional(),
    /** Selects base_url_options by environment label (e.g. "eu", "sandbox"). */
    base_url_environment: z.string().optional(),
    force_new: z
      .boolean()
      .optional()
      .describe(
        "Set true only when the operator explicitly wants a SEPARATE connector on a base_url that already has one. Skips URL reuse and mints an independent draft.",
      ),
  })
  .openapi("StartConnectorFromTemplateToolInput");

export const startConnectorFromTemplateTool: ConversationTool = {
  name: "start_connector_from_template",
  description:
    "Start a connector draft from a connector template. Use this only when the user wants the template; templates are optional accelerators.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "connector",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const resolved = await resolveConnectorTemplate({
      db: ctx.db,
      tenant_id: ctx.tenant_id,
      slug: args.template_slug,
    });
    if (!resolved) {
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
    const template = resolved.template;
    const enriched = enrichConnectorFromTemplate(
      { name: args.name, environment: args.environment },
      template,
      args.base_url_environment ? { environment: args.base_url_environment } : undefined,
    );
    // enriched.base_url falls back to template.base_url (which can now be
    // null for per-tenant templates like AppSync / GCP). When still null,
    // omit the field so validateConnectorDraft surfaces the missing-URL
    // gap and the operator is asked to provide it.
    const resolvedBaseUrl = enriched.base_url ?? template.base_url ?? undefined;
    // Reuse-existing-saved-connector: same dedup as
    // start_connector_from_description so two starts against the same
    // upstream URL never produce two saved connectors.
    const reuseEnvelope = await findReusableConnectorByUrl({
      tenant_id: ctx.tenant_id,
      environment: args.environment,
      base_url: resolvedBaseUrl,
      driver: enriched.driver,
      // Explicit operator request for a separate connector on this URL.
      ...(args.force_new ? { force_new: true } : {}),
      db: ctx.db,
    });
    if (reuseEnvelope) {
      return { ok: true, data: reuseEnvelope };
    }
    const connector = {
      name: enriched.name,
      slug: enriched.slug ?? template.slug,
      driver: enriched.driver,
      environment: enriched.environment,
      ...(resolvedBaseUrl ? { base_url: resolvedBaseUrl } : {}),
      auth_type: enriched.auth_type,
      config: withMcpConfigDefaults(enriched.driver, enriched.auth_type ?? "none", enriched.config),
      description: template.description,
      template_slug: template.slug,
      template_name: template.name,
      template_source: resolved.source,
      docs: template.ingestion_url ? [template.ingestion_url] : [],
      latest_probe: null,
      saved_connector_id: null,
    } as const;
    const validation = validateConnectorDraft(connector, [template]);
    const nextDraft = withConnectorDraft(
      ctx.getDraft(),
      { ...connector, validation },
      "connector_started_from_template",
    );
    await ctx.setDraft(nextDraft);

    // Auto-discover the connector's endpoint catalog when the template
    // points at an OpenAPI/Swagger spec. The result is cached for 24h
    // in `knowledge_sources` (see runDiscoveryCached) so the downstream
    // `propose_step` flow can pull `/v2/projects` etc. from the catalog
    // instead of inventing the URL. Without this, the LLM authoring
    // a workflow against (e.g.) DigitalOcean has no spec to ground on
    // and ends up guessing `/projects` (404). Best-effort — discovery
    // failures don't block connector creation.
    let discoveryStatus: { ran: boolean; endpoint_count?: number; error?: string } = {
      ran: false,
    };
    if (template.ingestion_url) {
      try {
        ctx.onLog?.(
          "info",
          `auto-discovering ${template.slug} endpoints from ${template.ingestion_url}`,
        );
        const out = await runDiscoveryCached(
          {
            db: ctx.db,
            tenant_id: ctx.tenant_id,
            actor_id: ctx.actor_id,
            ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          },
          { template_id: template.slug, force_refresh: false },
        );
        discoveryStatus = {
          ran: true,
          endpoint_count: out.result.endpoints.length,
        };
        ctx.onLog?.(
          "info",
          `cached ${out.result.endpoints.length} endpoint${
            out.result.endpoints.length === 1 ? "" : "s"
          } for ${template.slug}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        discoveryStatus = { ran: true, error: message };
        logger.warn({
          module: "conversation_tool",
          action: "start_connector_from_template.discovery_failed",
          tenant_id: ctx.tenant_id,
          template_slug: template.slug,
          error: message,
        });
      }
    }

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
            template_slug: connector.template_slug,
            template_source: connector.template_source,
            allowed_auth_types: allowedTemplateAuthTypes(template),
            required_fields: inferTemplateRequiredFields(template),
            validation,
          },
          next_phase: buildAuthNextPhase(connector.auth_type),
          validation,
          endpoint_catalog: discoveryStatus,
        },
      }),
    };
  },
};
