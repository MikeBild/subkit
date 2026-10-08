import type { GateOutcome } from "../conversations/confirmation.ts";
import type { ConversationSurface } from "../conversations/lifecycle-view.ts";
import type { ToolPolicyMode } from "../conversations/tool-policies.ts";
import type { TimeoutPhase } from "../conversations/turn-failure.ts";
import type { AuthoringStage } from "../conversations/types.ts";
import type { ConfirmReason } from "../tools/types.ts";

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

function allowlist<T extends string>(members: Record<T, true>): ReadonlySet<string> {
  return new Set(Object.keys(members));
}

export function boundedLabel(allowed: ReadonlySet<string>, value: string): string {
  return allowed.has(value) ? value : "other";
}

export const TOOL_POLICY_RULES = allowlist<ConfirmReason>({
  inline_credential: true,
  connector_trust: true,
  never_gate: true,
  permission_mode: true,
  conversation_override: true,
  computed_from_input: true,
  tool_default: true,
  category_default: true,
  held_writes: true,
});

export const TOOL_POLICY_MODES = allowlist<ToolPolicyMode>({
  no_confirm: true,
  confirm_before_execution: true,
  confirm_after_execution: true,
});

export const TOOL_POLICY_OUTCOMES = allowlist<GateOutcome>({
  proceed: true,
  confirm: true,
  refused: true,
  unavailable: true,
  duplicate_pending: true,
  approval_failed: true,
});

export const CONVERSATION_SURFACE_LABELS = allowlist<ConversationSurface>({
  web: true,
  sk_interactive: true,
  sk_headless: true,
  mcp: true,
  chat: true,
  api: true,
});

export const CONVERSATION_STAGE_LABELS = allowlist<AuthoringStage>({
  idle: true,
  connector_targeted: true,
  connector_draft_started: true,
  connector_inspected: true,
  connector_validated: true,
  connector_authenticated: true,
  connector_probed: true,
  connector_persisted: true,
  workflow_targeted: true,
  workflow_draft_started: true,
  workflow_inspected: true,
  workflow_validated: true,
  workflow_previewed: true,
  workflow_persisted: true,
  workflow_executed: true,
  diagnosing: true,
  repairing: true,
});

export const LLM_TIMEOUT_PHASES = allowlist<TimeoutPhase>({
  total: true,
  first_chunk: true,
  step: true,
  chunk: true,
});
