import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { createConnector } from "../../connectors/service.ts";
import { upsertTemplateOAuthCredentials } from "../../connectors/template-credentials.ts";
import {
  listResolvedConnectorTemplates,
  type ResolvedConnectorTemplate,
  resolveConnectorTemplate,
} from "../../connectors/template-resolver.ts";
import {
  createTenantConnectorTemplate,
  deleteTenantConnectorTemplate,
} from "../../connectors/template-service.ts";
import templateSkillsJson from "../../connectors/template-skills.json" with { type: "json" };
import { matchTemplatesByUrl, type TemplateUrlMatch } from "../../connectors/template-url-match.ts";
import type { ConnectorView } from "../../connectors/types.ts";
import { ingestTemplateDocsForConnector } from "../../docs-ingestion/service.ts";
import { logger } from "../../logging/logger.ts";
import { createSkill } from "../../skills/service.ts";
import { IdParam } from "../common-schemas.ts";
import {
  adminRejection,
  ConnectorResponseSchema,
  CreateBodySchema,
  FromTemplateBody,
  ListResponseSchema,
  MatchUrlQuery,
  MatchUrlResponseSchema,
  SlugParam,
  serializeConnector,
  serializeResolvedTemplate,
  TemplateOAuthCredentialBody,
  TemplateOAuthCredentialResponse,
  TemplateRowSchema,
  TemplateSlugParam,
  templateAuthToConnectorAuth,
} from "./connector-template-representation.ts";
import { defineOperation, type OperationScope, reject } from "./index.ts";

type TemplateList = z.infer<typeof ListResponseSchema>;
type TemplateRow = z.infer<typeof TemplateRowSchema>;
type CreateBody = z.infer<typeof CreateBodySchema>;
type MatchUrlInput = z.infer<typeof MatchUrlQuery>;
type MatchUrlBody = z.infer<typeof MatchUrlResponseSchema>;
type OAuthCredentialInput = { readonly slug: string } & z.infer<typeof TemplateOAuthCredentialBody>;
type FromTemplateInput = { readonly slug: string } & z.infer<typeof FromTemplateBody>;

interface TemplateSkill {
  title: string;
  body: string;
  examples?: string[];
  best_practices?: string[];
  pitfalls?: string[];
  doc_refs?: string[];
}

export const listConnectorTemplatesOperation = defineOperation<Record<string, never>, TemplateList>(
  {
    id: "connector_template.list",
    summary: "List connector templates (built-ins + tenant overrides)",
    permission: "connector:read",
    effect: "read",
    async handler(scope) {
      const resolved = await listResolvedConnectorTemplates(scope.db, scope.tenant_id);
      return { items: resolved.map(serializeResolvedTemplate) };
    },
    http: {
      method: "get",
      path: "/v1/connector-templates",
      tags: ["connectors"],
      response: ListResponseSchema,
      toInput: () => ({}),
      toBody: (result) => result,
    },
  },
);

export const createConnectorTemplateOperation = defineOperation<CreateBody, TemplateRow>({
  id: "connector_template.create",
  summary: "Add a tenant connector template override",
  permission: "connector:write",
  effect: "write",
  audit: AuditAction.CONNECTOR_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const forbidden = adminRejection(principal);
    if (forbidden) return forbidden;
    const row = await createTenantConnectorTemplate(
      {
        tenant_id: scope.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        input: {
          slug: body.slug,
          name: body.name,
          driver: body.driver,
          base_url: body.base_url ?? "",
          auth_type: body.auth_type,
          oauth: body.oauth ?? null,
          default_skill: body.default_skill ?? null,
          ingestion_source: body.ingestion_source ?? "unsupported",
          ingestion_url: body.ingestion_url ?? null,
          icon: body.icon,
          description: body.description,
          category: body.category,
          tags: body.tags ?? [],
          aliases: body.aliases ?? [],
          setup_instructions: body.setup_instructions,
          auth_options: body.auth_options ?? [],
          url_pattern: body.url_pattern ?? "",
          keywords: body.keywords ?? [],
          inline_schema: body.inline_schema ?? null,
          probe_endpoint: body.probe_endpoint ?? null,
          credential_hints: body.credential_hints ?? [],
          base_url_options: body.base_url_options ?? [],
          pagination_defaults: body.pagination_defaults ?? null,
          capabilities: body.capabilities,
        },
      },
      scope.db,
    );
    return { ...body, id: row.id, source: "tenant", version: 1 };
  },
  http: {
    method: "post",
    path: "/v1/connector-templates",
    tags: ["connectors"],
    body: CreateBodySchema,
    response: TemplateRowSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 403: "Forbidden" },
    toInput: ({ json }) => json as CreateBody,
    toBody: (result) => result,
  },
});

export const deleteConnectorTemplateOperation = defineOperation<{ readonly id: string }, true>({
  id: "connector_template.delete",
  summary: "Delete a tenant connector template override",
  permission: "connector:write",
  effect: "write",
  audit: AuditAction.CONNECTOR_DELETED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const forbidden = adminRejection(principal);
    if (forbidden) return forbidden;
    const deleted = await deleteTenantConnectorTemplate(
      {
        tenant_id: scope.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        id: input.id,
      },
      scope.db,
    );
    return deleted ? true : reject.notFound("connector_template");
  },
  http: {
    method: "delete",
    path: "/v1/connector-templates/{id}",
    tags: ["connectors"],
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: () => null,
  },
});

export const matchConnectorTemplateUrlOperation = defineOperation<MatchUrlInput, MatchUrlBody>({
  id: "connector_template.match_url",
  summary: "Match a URL to connector templates by url_pattern regex",
  permission: "connector:read",
  effect: "read",
  async handler(scope, { url, limit }) {
    const resolvedTemplates = await listResolvedConnectorTemplates(scope.db, scope.tenant_id);
    const matches: Array<TemplateUrlMatch & { resolved: ResolvedConnectorTemplate }> =
      matchTemplatesByUrl(
        url,
        limit,
        resolvedTemplates.map((entry) => entry.template),
      ).flatMap((entry) => {
        const resolved = resolvedTemplates.find(
          (candidate) => candidate.template.slug === entry.template.slug,
        );
        return resolved ? [{ ...entry, resolved }] : [];
      });
    return {
      url,
      matched: matches.length > 0,
      matches: matches.map(({ template, score, matched_segment, resolved }) => ({
        slug: template.slug,
        name: template.name,
        driver: template.driver,
        source: resolved.source,
        version: template.version,
        score,
        matched_segment,
        description: template.description,
        setup_instructions: template.setup_instructions,
        credential_hints: template.credential_hints,
        keywords: template.keywords,
        capabilities: template.capabilities,
      })),
    };
  },
  http: {
    method: "get",
    path: "/v1/connector-templates/match-url",
    tags: ["connectors"],
    query: MatchUrlQuery,
    response: MatchUrlResponseSchema,
    toInput: ({ query }) => query as MatchUrlInput,
    toBody: (result) => result,
  },
});

export const storeTemplateOAuthCredentialsOperation = defineOperation<
  OAuthCredentialInput,
  Awaited<ReturnType<typeof upsertTemplateOAuthCredentials>>
>({
  id: "connector_template.oauth_credentials.store",
  summary: "Store tenant-scoped OAuth client credentials for a connector template",
  permission: "connector:write",
  effect: "write",
  audit: AuditAction.CREDENTIAL_CREATED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const forbidden = adminRejection(principal);
    if (forbidden) return forbidden;
    const resolved = await resolveConnectorTemplate({
      db: scope.db,
      tenant_id: scope.tenant_id,
      slug: input.slug,
    });
    if (!resolved) return reject.notFound("connector_template");
    return upsertTemplateOAuthCredentials(
      {
        tenant_id: scope.tenant_id,
        template_slug: input.slug,
        value: { client_id: input.client_id, client_secret: input.client_secret },
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/connector-templates/{slug}/oauth-credentials",
    tags: ["connectors"],
    params: TemplateSlugParam,
    body: TemplateOAuthCredentialBody,
    response: TemplateOAuthCredentialResponse,
    success: { status: 200, description: "Stored" },
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: ({ param, json }) => ({
      slug: (param as { slug: string }).slug,
      ...(json as z.infer<typeof TemplateOAuthCredentialBody>),
    }),
    toBody: (result) => result,
  },
});

function seedDiscovery(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  templateSlug: string,
  connectorId: string,
): void {
  void runDiscoveryCached(
    {
      db: scope.db,
      tenant_id: scope.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
    },
    { template_id: templateSlug, force_refresh: false },
  )
    .then((out) => {
      logger.info({
        module: "connector_templates",
        action: "from_template.discovery_seeded",
        msg: "endpoint catalog discovered and cached for the new connector",
        tenant_id: scope.tenant_id,
        template_slug: templateSlug,
        connector_id: connectorId,
        endpoint_count: out.result.endpoints.length,
      });
    })
    .catch((err: unknown) => {
      logger.warn({
        module: "connector_templates",
        action: "from_template.discovery_failed",
        msg: "background endpoint discovery failed; authoring grounding falls back to on-demand discovery",
        tenant_id: scope.tenant_id,
        template_slug: templateSlug,
        connector_id: connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export const createConnectorFromTemplateOperation = defineOperation<
  FromTemplateInput,
  ConnectorView
>({
  id: "connector.from_template",
  summary: "Instantiate a connector from a template",
  permission: "connector:write",
  effect: "write",
  audit: AuditAction.CONNECTOR_CREATED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const forbidden = adminRejection(principal);
    if (forbidden) return forbidden;
    const resolved = await resolveConnectorTemplate({
      db: scope.db,
      tenant_id: scope.tenant_id,
      slug: input.slug,
    });
    if (!resolved) return reject.notFound("connector_template");
    const template = resolved.template;
    if (input.ingest_now && template.ingestion_source === "unsupported") {
      return reject.status(
        400,
        "unsupported_ingestion_source",
        `template ${template.slug} does not have a supported ingestion source`,
        { slug: template.slug },
      );
    }
    const created = await createConnector(
      {
        tenant_id: scope.tenant_id,
        input: {
          name: input.name ?? template.name,
          slug: template.slug,
          driver: template.driver,
          environment: input.environment ?? "dev",
          auth_type: templateAuthToConnectorAuth(template.auth_type),
          template_slug: template.slug,
          template_source: resolved.source,
          ...(input.base_url_environment
            ? { template_base_url_environment: input.base_url_environment }
            : {}),
        },
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      scope.db,
    );
    const shouldIngest =
      input.ingest_now ?? (template.inline_schema !== null || template.ingestion_url !== null);
    if (shouldIngest) {
      await ingestTemplateDocsForConnector(
        {
          tenant_id: scope.tenant_id,
          connector_id: created.id,
          template,
          actor_id: principal.id,
          actor: actorOf(principal),
        },
        scope.db,
      );
    }
    if (shouldIngest && template.ingestion_url)
      seedDiscovery(scope, principal, template.slug, created.id);
    const skill = template.default_skill
      ? ((templateSkillsJson as Record<string, unknown>)[template.default_skill] as
          | TemplateSkill
          | undefined)
      : undefined;
    if (skill) {
      try {
        await createSkill(
          {
            tenant_id: scope.tenant_id,
            input: {
              scope: "connector",
              connector_id: created.id,
              title: skill.title,
              body: skill.body,
              examples: skill.examples,
              best_practices: skill.best_practices,
              pitfalls: skill.pitfalls,
              doc_refs: skill.doc_refs,
            },
            actor_id: principal.id,
            actor_type: principal.kind,
          },
          scope.db,
        );
      } catch {}
    }
    await auditAwait(
      {
        tenant_id: scope.tenant_id,
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
      scope.db,
    );
    return created;
  },
  http: {
    method: "post",
    path: "/v1/connectors/from-template/{slug}",
    tags: ["connectors"],
    params: SlugParam,
    body: FromTemplateBody,
    response: ConnectorResponseSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 403: "Forbidden", 404: "Not found" },
    toInput: ({ param, json }) => ({
      slug: (param as { slug: string }).slug,
      ...(json as z.infer<typeof FromTemplateBody>),
    }),
    toBody: (result) => serializeConnector(result),
  },
});
