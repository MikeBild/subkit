import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
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
      }
    }

    const referencedIds = collectConnectorIds(toolInput);
    for (const id of collectConnectorIds(draft.workflow)) referencedIds.add(id);
    if (referencedIds.size > 0) {
      const rows = await db
        .select({
          driver: connectors.driver,
          template_slug: connectors.template_slug,
        })
        .from(connectors)
        .where(
          and(eq(connectors.tenant_id, tenant_id), inArray(connectors.id, [...referencedIds])),
        );
      for (const row of rows) {
        if (row.driver) drivers.add(row.driver.toLowerCase());
        if (row.template_slug) templates.add(row.template_slug.toLowerCase());
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

function collectConnectorIds(input: unknown): Set<string> {
  const out = new Set<string>();
  walk(input, out, 0);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walk(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 16) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "connector_id" && typeof v === "string" && UUID_RE.test(v)) {
      out.add(v);
    } else {
      walk(v, out, depth + 1);
    }
  }
}
