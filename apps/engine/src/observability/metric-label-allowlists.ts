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

export const CONNECTOR_HEALTH_VALUES = new Set<string>([
  "ok",
  "auth_failed",
  "endpoint_gone",
  "deprecated",
  "not_found",
  "rate_limited",
  "degraded",
]);

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

export function _resetConnectorSlugBudgetForTests(): void {
  _seenConnectorSlugs.clear();
}
