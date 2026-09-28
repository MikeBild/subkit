import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

/** The engine's failure classification — one enum, published by its schema. */
export type CauseClass = components["schemas"]["FailureCauseClass"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * Every class the engine names, as the cockpit's own words.
 *
 * `satisfies Record<CauseClass, …>` makes a class the engine adds and this
 * table lacks a compile error, not a machine value on screen. The engine's own
 * `unknown` gets words too — "not classified" is what the engine said; it is
 * not the §2-banned "Unbekannt".
 */
const CAUSE_CLASS_KEYS = {
  ok: "cause.ok",
  auth_failed: "cause.auth_failed",
  placeholder_unresolved: "cause.placeholder_unresolved",
  schema_mismatch: "cause.schema_mismatch",
  timeout: "cause.timeout",
  aborted: "cause.aborted",
  connector_missing: "cause.connector_missing",
  budget_exhausted: "cause.budget_exhausted",
  driver_error: "cause.driver_error",
  preview_unsupported: "cause.preview_unsupported",
  unknown: "cause.unknown",
} as const satisfies Record<CauseClass, TranslationKey>;

/**
 * A cause class as the reader sees it. A value this build has no word for —
 * a newer engine's class — stays the engine's own value, marked as one
 * (§15.2), never "Unbekannt" (§2).
 */
export function causeClassLabel(value: string, t: Translate): CatalogLabel {
  return catalogLabel(value, (CAUSE_CLASS_KEYS as Record<string, TranslationKey>)[value], t);
}
