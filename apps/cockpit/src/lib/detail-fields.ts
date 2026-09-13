import type { TranslationKey } from "./i18n";

/**
 * What a detail page shows about a record, and under which words.
 *
 * The overview used to be built from the response itself: every scalar field
 * the engine happened to return, labelled `key.replaceAll("_", " ")`. On the
 * connector page that WAS the page, and it read as the engine's own field list
 * — "Updated At", "Auth Type", "Needs Reauth" — in a cockpit that is otherwise
 * German, with the record's UUID as its first and most prominent value.
 *
 * A mechanical label is worse than a missing one: it looks designed. Nobody
 * chose those words, nobody can translate them, and a field the engine renames
 * silently renames itself on screen.
 *
 * So the table below is a decision per field, not a transform. The label keys
 * are the ones the LIST columns already use, which is the point: a connector's
 * driver is "Treiber" in the list and "Treiber" on its detail page, because
 * both read the same key. A second vocabulary for the same fields is how two
 * surfaces start naming one fact differently (§12).
 *
 * Three rules decide what is NOT here:
 *
 *   - Identifiers. `id`, `tenant_id`, `workflow_id` and their kin never appear
 *     on a surface (§5). The detail page keeps the record's own reference one
 *     disclosure deeper, for the person who has to quote it to operations.
 *   - The record's name. The heading above already says it; repeating it in the
 *     first cell is the same fact twice.
 *   - Anything unknown. A field this table does not name is not rendered at
 *     all. The alternative — printing the raw key — is exactly the defect this
 *     replaces, and dressing a raw value as a designed label is a lie about how
 *     much thought went into it.
 */
export type DetailFieldFormat =
  "text" | "date" | "boolean" | "status" | "bytes" | "scope" | "sideEffects" | "maturity";

export interface DetailField {
  key: string;
  labelKey: TranslationKey;
  format: DetailFieldFormat;
}

/** The reading order of the overview — chosen here, not inherited from JSON. */
export const DETAIL_FIELDS: readonly DetailField[] = [
  { key: "status", labelKey: "resource.field.status", format: "status" },
  { key: "lifecycle", labelKey: "catalog.lifecycle", format: "status" },
  { key: "health_state", labelKey: "catalog.health", format: "status" },
  { key: "health_reason", labelKey: "resource.field.healthReason", format: "text" },
  { key: "enabled", labelKey: "catalog.enabled", format: "boolean" },
  { key: "auth_type", labelKey: "resource.field.authType", format: "text" },
  { key: "needs_reauth", labelKey: "resource.field.needsReauth", format: "boolean" },
  { key: "auth_failed_at", labelKey: "resource.field.authFailedAt", format: "date" },
  { key: "scope", labelKey: "resource.field.scope", format: "scope" },
  { key: "side_effects", labelKey: "catalog.sideEffects", format: "sideEffects" },
  { key: "maturity", labelKey: "catalog.maturity", format: "maturity" },
  { key: "category", labelKey: "catalog.block", format: "text" },
  { key: "driver", labelKey: "catalog.driver", format: "text" },
  { key: "environment", labelKey: "catalog.environment", format: "text" },
  { key: "source_type", labelKey: "catalog.sourceType", format: "text" },
  { key: "content_type", labelKey: "catalog.contentType", format: "text" },
  { key: "scan_result", labelKey: "catalog.scanResult", format: "status" },
  { key: "chunk_count", labelKey: "catalog.chunks", format: "text" },
  { key: "bytes_total", labelKey: "catalog.size", format: "bytes" },
  { key: "size_bytes", labelKey: "catalog.size", format: "bytes" },
  { key: "slug", labelKey: "resource.field.slug", format: "text" },
  { key: "version", labelKey: "catalog.version", format: "text" },
  { key: "current_version", labelKey: "catalog.version", format: "text" },
  { key: "last_executed_at", labelKey: "catalog.lastRun", format: "date" },
  { key: "created_at", labelKey: "resource.field.createdAt", format: "date" },
  { key: "updated_at", labelKey: "catalog.updated", format: "date" },
];

/** The value vocabularies shared with the catalogue list's own cells. */
export const SCOPE_KEYS: Record<string, TranslationKey> = {
  global: "scope.global",
  connector: "scope.connector",
  workflow: "scope.workflow",
};

export const SIDE_EFFECT_KEYS: Record<string, TranslationKey> = {
  none: "sideEffects.none",
  read: "sideEffects.read",
  write: "sideEffects.write",
  destructive: "sideEffects.destructive",
};

export interface DetailEntry extends DetailField {
  value: unknown;
}

/**
 * The curated fields this record actually carries, in the order above.
 *
 * A field the record does not mention is left out rather than rendered as `—`:
 * a workflow has no scan verdict, and a row of dashes for every field some
 * other collection owns is noise, not information. A field the record DOES
 * carry as `null` stays — that is a measured absence and the page says so.
 */
export function detailEntries(record: Record<string, unknown>): DetailEntry[] {
  return DETAIL_FIELDS.filter((field) => record[field.key] !== undefined).map((field) => ({
    ...field,
    value: record[field.key],
  }));
}
