import { and, eq, inArray } from "drizzle-orm";
import { matchTemplateByUrl } from "../connectors/template-url-match.ts";
import type { Db } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { loadDraft } from "./draft.ts";

export interface ScopeFacts {
  connector_drivers: string[];
  connector_templates: string[];
}

const EMPTY: ScopeFacts = { connector_drivers: [], connector_templates: [] };

export async function resolveScopeFactsForConversation(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  toolInput: unknown,
): Promise<ScopeFacts> {
  try {
    const draft = await loadDraft(tenant_id, conversation_id, db);
    const drivers = new Set<string>();
    const templates = new Set<string>();

    if (draft.connector) {
      if (draft.connector.driver) drivers.add(draft.connector.driver.toLowerCase());
      if (draft.connector.template_slug) {
        templates.add(draft.connector.template_slug.toLowerCase());
      } else {
        for (const slug of inferTemplateSlugs(draft.connector.base_url, [])) templates.add(slug);
      }
    }

    const referencedIds = collectConnectorPaths(toolInput);
    for (const [id, paths] of collectConnectorPaths(draft.workflow)) {
      const known = referencedIds.get(id) ?? new Set<string>();
      for (const path of paths) known.add(path);
      referencedIds.set(id, known);
    }
    if (referencedIds.size > 0) {
      const rows = await db
        .select({
          id: connectors.id,
          driver: connectors.driver,
          base_url: connectors.base_url,
          template_slug: connectors.template_slug,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenant_id),
            inArray(connectors.id, [...referencedIds.keys()]),
          ),
        );
      for (const row of rows) {
        if (row.driver) drivers.add(row.driver.toLowerCase());
        if (row.template_slug) templates.add(row.template_slug.toLowerCase());
        else
          for (const slug of inferTemplateSlugs(row.base_url, referencedIds.get(row.id) ?? []))
            templates.add(slug);
      }
    }

    return {
      connector_drivers: [...drivers].sort(),
      connector_templates: [...templates].sort(),
    };
  } catch (err) {
    logger.warn({
      module: "conversations.scope_facts",
      action: "scope_facts.failed",
      tenant_id,
      conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }
}

function inferTemplateSlugs(
  baseUrl: string | null | undefined,
  paths: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  if (!baseUrl) return out;
  const base = baseUrl.replace(/\/+$/, "");
  for (const url of [base, ...[...paths].map((path) => `${base}/${path.replace(/^\/+/, "")}`)]) {
    const match = matchTemplateByUrl(url);
    if (match) out.add(match.template.slug.toLowerCase());
  }
  return out;
}

export function collectConnectorIds(input: unknown): Set<string> {
  return new Set(collectConnectorPaths(input).keys());
}

function collectConnectorPaths(input: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  walk(input, out, 0);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walk(value: unknown, out: Map<string, Set<string>>, depth: number): void {
  if (depth > 16) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const id = record.connector_id;
  if (typeof id === "string" && UUID_RE.test(id)) {
    const paths = out.get(id) ?? new Set<string>();
    if (typeof record.path === "string" && record.path.startsWith("/")) paths.add(record.path);
    out.set(id, paths);
  }
  for (const [key, v] of Object.entries(record)) {
    if (key !== "connector_id") walk(v, out, depth + 1);
  }
}
