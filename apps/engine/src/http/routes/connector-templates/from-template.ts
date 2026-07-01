// Connector instantiation from a connector template:
//   POST /v1/connectors/from-template/{slug}

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { runDiscoveryCached } from "../../../connectors/discovery/service.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import {
  resolveConnectorTemplate,
  UnsupportedIngestionSourceError,
} from "../../../connectors/index.ts";
import templateSkillsJson from "../../../connectors/template-skills.json" with { type: "json" };
import * as docsSvc from "../../../docs-ingestion/index.ts";
import { logger } from "../../../logging/logger.ts";
import * as skillSvc from "../../../skills/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  ConnectorResponseSchema,
  FromTemplateBody,
  requireAdmin,
  SlugParam,
  serializeConnector,
  templateAuthToConnectorAuth,
} from "./schemas.ts";

const fromTemplateRoute = createRoute({
  method: "post",
  path: "/v1/connectors/from-template/{slug}",
  tags: ["connectors"],
  summary: "Instantiate a connector from a template",
  security: [{ bearerAuth: [] }],
  request: {
    params: SlugParam,
    body: { content: { "application/json": { schema: FromTemplateBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ConnectorResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerFromTemplateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(fromTemplateRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { slug } = c.req.valid("param");
    const body = c.req.valid("json");

    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    const template = resolved.template;

    if (body.ingest_now && template.ingestion_source === "unsupported") {
      throw new UnsupportedIngestionSourceError(template.slug);
    }
    const created = await connectorSvc.createConnector(
      {
        tenant_id: principal.tenant_id,
        input: {
          name: body.name ?? template.name,
          slug: template.slug,
          driver: template.driver,
          environment: body.environment ?? "dev",
          auth_type: templateAuthToConnectorAuth(template.auth_type),
          template_slug: template.slug,
          template_source: resolved.source,
          ...(body.base_url_environment
            ? { template_base_url_environment: body.base_url_environment }
            : {}),
        },
        actor_id: principal.id,
      },
      db,
    );
    const shouldIngest =
      body.ingest_now ?? (template.inline_schema !== null || template.ingestion_url !== null);
    if (shouldIngest) {
      await docsSvc.ingestTemplateDocsForConnector(
        {
          tenant_id: principal.tenant_id,
          connector_id: created.id,
          template,
          actor_id: principal.id,
        },
        db,
      );
    }

    // Endpoint discovery pre-seed. The authoring pipeline grounds
    // `author_workflow` in the discovered endpoint index; the
    // conversation path (`start_connector_from_template`) already runs
    // this, but a connector installed over HTTP (sk `/install`) had no
    // index until the first authoring turn explicitly discovered it —
    // fail-open grounding is exactly how invented paths slip through.
    // Backgrounded because discovery can take tens of seconds and is
    // best-effort: the 24h cache in `runDiscoveryCached` makes a later
    // authoring turn pick up the result either way.
    if (template.ingestion_url) {
      void runDiscoveryCached(
        { db, tenant_id: principal.tenant_id, actor_id: principal.id },
        { template_id: template.slug, force_refresh: false },
      )
        .then((out) => {
          logger.info({
            module: "connector_templates",
            action: "from_template.discovery_seeded",
            msg: "endpoint catalog discovered and cached for the new connector",
            tenant_id: principal.tenant_id,
            template_slug: template.slug,
            connector_id: created.id,
            endpoint_count: out.result.endpoints.length,
          });
        })
        .catch((err: unknown) => {
          logger.warn({
            module: "connector_templates",
            action: "from_template.discovery_failed",
            msg: "background endpoint discovery failed; authoring grounding falls back to on-demand discovery",
            tenant_id: principal.tenant_id,
            template_slug: template.slug,
            connector_id: created.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // Seed the default skill for this connector from template-skills.json.
    if (template.default_skill) {
      const skillDef = (templateSkillsJson as Record<string, unknown>)[template.default_skill] as
        | {
            title: string;
            body: string;
            examples?: string[];
            best_practices?: string[];
            pitfalls?: string[];
            doc_refs?: string[];
          }
        | undefined;
      if (skillDef) {
        try {
          await skillSvc.createSkill(
            {
              tenant_id: principal.tenant_id,
              input: {
                scope: "connector",
                connector_id: created.id,
                title: skillDef.title,
                body: skillDef.body,
                examples: skillDef.examples,
                best_practices: skillDef.best_practices,
                pitfalls: skillDef.pitfalls,
                doc_refs: skillDef.doc_refs,
              },
              actor_id: principal.id,
            },
            db,
          );
        } catch {
          // Skill seeding is best-effort — don't fail connector creation.
        }
      }
    }

    // Add a second audit row that captures the template_slug provenance.
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CONNECTOR_CREATED,
        resource_type: "connector",
        resource_id: created.id,
        result: "success",
        metadata: {
          template_slug: template.slug,
          ingestion_source: template.ingestion_source,
          source: resolved.source === "tenant" ? "tenant_template" : "builtin_template",
        },
      },
      db,
    );

    return c.json(serializeConnector(created), 201);
  });
}
