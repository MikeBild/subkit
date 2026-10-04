import type { TranslationKey } from "./i18n";

export type DetailFieldFormat =
  | "text"
  | "date"
  | "boolean"
  | "status"
  | "bytes"
  | "scope"
  | "sideEffects"
  | "maturity";

export interface DetailField {
  key: string;
  labelKey: TranslationKey;
  format: DetailFieldFormat;
}

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

export function detailEntries(record: Record<string, unknown>): DetailEntry[] {
  return DETAIL_FIELDS.filter((field) => record[field.key] !== undefined).map((field) => ({
    ...field,
    value: record[field.key],
  }));
}

export function recordBarFacts(record: Record<string, unknown>): {
  status: string | null;
  version: number | null;
} {
  const status =
    typeof record.status === "string" && record.status
      ? record.status
      : typeof record.lifecycle === "string" && record.lifecycle
        ? record.lifecycle
        : null;
  const raw = record.version ?? record.current_version;
  const version =
    typeof raw === "number" && Number.isInteger(raw)
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : null;
  return { status, version };
}
