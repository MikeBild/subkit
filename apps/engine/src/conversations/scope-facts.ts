// Resolve `ScopeFacts` (connector drivers + template slugs in scope)
// for a given conversation turn. Consumed by `skill-autoload.ts` to
// decide which `connector_driver` / `connector_template` activation
// rules fire.
//
// Sources, in priority order:
//   1. Tool input — `connector_id` references that resolve to a row.
//      `propose_step` / `dry_run_step` / `call_connector` carry one;
//      `build_workflow` carries an array of steps each with their own.
//   2. Conversation draft — the connector currently being authored
//      (`draft.connector.driver` / `draft.connector.template_slug`)
//      and any connectors persisted as part of the workflow draft.
//   3. Conversation snapshot — `loaded_skills` already record the
//      tenant view of which connectors are in chat scope; we reach
//      through the draft for the canonical answer rather than parsing
//      that snapshot here.
//
// The function is best-effort. A DB blip or a half-shaped draft must
// not break tool dispatch — callers fall back to empty scope facts and
// the matcher just returns fewer activations.

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

    // 1. Connector being authored in the draft.
    if (draft.connector) {
      if (draft.connector.driver) drivers.add(draft.connector.driver.toLowerCase());
      if (draft.connector.template_slug) {
        templates.add(draft.connector.template_slug.toLowerCase());
      }
    }

    // 2. Connector IDs referenced from the tool input. Single-step
    //    tools point at one (`connector_id` on the input or its `step`
    //    sub-object); `build_workflow` carries an array of steps.
    const referencedIds = collectConnectorIds(toolInput);
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
  // Bounded depth so a pathological tool input can't iterate forever.
  // Real tool inputs are shallow (≤6 nesting levels for build_workflow
  // with branch+loop bodies); 16 is safe headroom.
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
