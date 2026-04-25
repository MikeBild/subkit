import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { connectorTemplates } from "../db/schema/index.ts";
import {
  type ConnectorTemplate,
  ConnectorTemplateSchema,
  loadBuiltinTemplates,
} from "./templates.ts";

export type ConnectorTemplateSource = "builtin" | "tenant";
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ResolvedConnectorTemplate {
  id: string | null;
  source: ConnectorTemplateSource;
  template: ConnectorTemplate;
}

function escapeRegex(value: string): string {
  return value.replace(/[.\\/+?()[\]{}|^$]/g, "\\$&");
}

function emptyCapabilities(): ConnectorTemplate["capabilities"] {
  return {
    webhooks: false,
    webhook_events: [],
    rate_limits: null,
  };
}

export function materializeConnectorTemplateRow(
  row: typeof connectorTemplates.$inferSelect,
): ConnectorTemplate {
  const raw = row as Record<string, unknown>;
  return ConnectorTemplateSchema.parse({
    version: row.version ?? 1,
    slug: row.slug,
    name: row.name,
    driver: row.driver,
    base_url: row.base_url,
    auth_type: row.auth_type,
    oauth: row.oauth ?? null,
    default_skill: row.default_skill ?? null,
    ingestion_source: row.ingestion_source,
    ingestion_url: row.ingestion_url ?? null,
    icon: row.icon,
    description: row.description,
    category: (raw.category as string | null | undefined) || "custom",
    tags: (raw.tags as string[] | undefined) ?? [],
    aliases: (raw.aliases as string[] | undefined) ?? [],
    setup_instructions:
      (raw.setup_instructions as string | undefined) ||
      `Provide credentials to connect to ${row.name}.`,
    auth_options: (raw.auth_options as ConnectorTemplate["auth_options"] | undefined) ?? [],
    url_pattern: (raw.url_pattern as string | undefined) || `^${escapeRegex(row.base_url)}(/|$)`,
    keywords: (raw.keywords as string[] | undefined) ?? [],
    inline_schema: (raw.inline_schema as ConnectorTemplate["inline_schema"] | undefined) ?? null,
    probe_endpoint: (raw.probe_endpoint as ConnectorTemplate["probe_endpoint"] | undefined) ?? null,
    credential_hints:
      (raw.credential_hints as ConnectorTemplate["credential_hints"] | undefined) ?? [],
    base_url_options:
      (raw.base_url_options as ConnectorTemplate["base_url_options"] | undefined) ?? [],
    pagination_defaults:
      (raw.pagination_defaults as ConnectorTemplate["pagination_defaults"] | undefined) ?? null,
    capabilities:
      (raw.capabilities as ConnectorTemplate["capabilities"] | undefined) ?? emptyCapabilities(),
  });
}

export function parseTemplateSnapshot(value: unknown): ConnectorTemplate | null {
  const parsed = ConnectorTemplateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildTemplateBindingFields(resolved: ResolvedConnectorTemplate): {
  template_slug: string;
  template_name: string;
  template_source: ConnectorTemplateSource;
  template_version: number;
  template_snapshot: Record<string, unknown>;
} {
  return {
    template_slug: resolved.template.slug,
    template_name: resolved.template.name,
    template_source: resolved.source,
    template_version: resolved.template.version,
    template_snapshot: resolved.template as unknown as Record<string, unknown>,
  };
}

export async function listResolvedConnectorTemplates(
  db: Executor,
  tenant_id: string,
): Promise<ResolvedConnectorTemplate[]> {
  const builtins = loadBuiltinTemplates().map(
    (template): ResolvedConnectorTemplate => ({
      id: null,
      source: "builtin",
      template,
    }),
  );
  const tenantRows = await db
    .select()
    .from(connectorTemplates)
    .where(eq(connectorTemplates.tenant_id, tenant_id));
  const tenantBySlug = new Map(
    tenantRows.map((row) => [
      row.slug,
      {
        id: row.id,
        source: "tenant" as const,
        template: materializeConnectorTemplateRow(row),
      },
    ]),
  );
  const merged: ResolvedConnectorTemplate[] = [];
  for (const builtin of builtins) {
    const tenant = tenantBySlug.get(builtin.template.slug);
    if (tenant) continue;
    merged.push(builtin);
  }
  for (const row of tenantRows) {
    merged.push({
      id: row.id,
      source: "tenant",
      template: materializeConnectorTemplateRow(row),
    });
  }
  return merged;
}

export async function resolveConnectorTemplate(params: {
  db: Executor;
  tenant_id: string;
  slug: string;
  preferred_source?: ConnectorTemplateSource | null | undefined;
}): Promise<ResolvedConnectorTemplate | null> {
  const preferred = params.preferred_source ?? null;
  if (preferred === "tenant") {
    const rows = await params.db
      .select()
      .from(connectorTemplates)
      .where(
        and(
          eq(connectorTemplates.tenant_id, params.tenant_id),
          eq(connectorTemplates.slug, params.slug),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        id: row.id,
        source: "tenant",
        template: materializeConnectorTemplateRow(row),
      };
    }
    return null;
  }
  const tenantRows = await params.db
    .select()
    .from(connectorTemplates)
    .where(
      and(
        eq(connectorTemplates.tenant_id, params.tenant_id),
        eq(connectorTemplates.slug, params.slug),
      ),
    )
    .limit(1);
  const tenantRow = tenantRows[0];
  if (tenantRow) {
    return {
      id: tenantRow.id,
      source: "tenant",
      template: materializeConnectorTemplateRow(tenantRow),
    };
  }
  const builtin = loadBuiltinTemplates().find((template) => template.slug === params.slug) ?? null;
  if (!builtin) return null;
  return {
    id: null,
    source: "builtin",
    template: builtin,
  };
}

export function findTemplateAliasMatches(
  template: ConnectorTemplate,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return false;
  return template.aliases.some((alias) => alias.toLowerCase() === normalizedQuery);
}
