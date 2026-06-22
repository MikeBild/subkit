// Bounded label vocabularies for metric cardinality control.
//
// Any metric labeled by a value that could be operator/tenant/error-derived is
// collapsed against one of these allow-lists (unknown → "other") at its record
// helper in instrumentation.ts, so a future caller passing free text can never
// blow up the Prometheus series count. Split out of instrumentation.ts (which
// grows by a record helper per new metric) to keep it under the size ceiling.

/** Allow-list for the `label` on `db_transient_retries_total` — the fixed set
 *  of scheduler/reconcile passes that wrap themselves in retryTransient. Keep
 *  in sync with the retryTransient call sites in scheduler/reconciler.ts. */
export const DB_TRANSIENT_RETRY_LABELS = new Set<string>([
  "",
  "docs_auto_refresh",
  "knowledge_auto_refresh",
  "workflow_schedules",
  "drift_scan",
  "connector_reauth_scan",
  "endpoint_contract_scan",
  "skill_candidate_analyze",
  "files_cleanup",
  "mcp_oauth_cleanup",
  "chat_dedup_cleanup",
  "compute_desired",
]);

/** Allow-list for the `health` label on `connector_call_total`. Mirrors the
 *  `ConnectorHealth` union in connectors/health.ts. */
export const CONNECTOR_HEALTH_VALUES = new Set<string>([
  "ok",
  "auth_failed",
  "endpoint_gone",
  "deprecated",
  "not_found",
  "rate_limited",
  "degraded",
]);

// The connector `slug` on `connector_call_total` is tenant-controlled (a tenant
// mints its own connectors), so unlike a fixed enum it can't use a static
// allow-list. Bound it with a per-process cardinality cap instead: the first N
// distinct slugs seen each get their own series; everything past the cap
// collapses to "other". This caps the slug dimension at N+1 series per process
// regardless of adversarial connector churn or a typoed-slug storm — the same
// "unknown → other" guarantee the static allow-lists give, sized for a label
// whose vocabulary is open. N is generous: a real tenant has tens of connectors.
const CONNECTOR_SLUG_CARDINALITY_CAP = 200;
const _seenConnectorSlugs = new Set<string>();
export function boundedConnectorSlug(slug: string): string {
  if (_seenConnectorSlugs.has(slug)) return slug;
  if (_seenConnectorSlugs.size < CONNECTOR_SLUG_CARDINALITY_CAP) {
    _seenConnectorSlugs.add(slug);
    return slug;
  }
  return "other";
}

/** Test-only — reset the per-process slug cardinality budget. */
export function _resetConnectorSlugBudgetForTests(): void {
  _seenConnectorSlugs.clear();
}
