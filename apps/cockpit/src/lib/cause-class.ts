import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

export type CauseClass = components["schemas"]["FailureCauseClass"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const CAUSE_CLASS_KEYS = {
  ok: "cause.ok",
  auth_failed: "cause.auth_failed",
  placeholder_unresolved: "cause.placeholder_unresolved",
  schema_mismatch: "cause.schema_mismatch",
  timeout: "cause.timeout",
  aborted: "cause.aborted",
  connector_missing: "cause.connector_missing",
  budget_exhausted: "cause.budget_exhausted",
  connector_unavailable: "cause.connector_unavailable",
  refused_before_start: "cause.refused_before_start",
  authority_mismatch: "cause.authority_mismatch",
  payload_invalid: "cause.payload_invalid",
  driver_error: "cause.driver_error",
  preview_unsupported: "cause.preview_unsupported",
  unknown: "cause.unknown",
  incomplete_read: "cause.incomplete_read",
  rate_limited: "cause.rate_limited",
} as const satisfies Record<CauseClass, TranslationKey>;

export function causeClassKey(value: string): TranslationKey | undefined {
  return (CAUSE_CLASS_KEYS as Record<string, TranslationKey>)[value];
}

export function causeClassLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, causeClassKey(value), t);
}
