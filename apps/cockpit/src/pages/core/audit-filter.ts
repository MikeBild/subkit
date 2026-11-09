export type AuditScope = "all" | "decisions" | "operations";

export interface AuditLinkFilter {
  resourceType: string | null;
  resourceId: string | null;
  traceId: string | null;
  scope: AuditScope | null;
  actions: string[];
  tsFrom: string | null;
  tsTo: string | null;
}

const DECISION_ACTIONS = [
  "patch_candidate.approved",
  "patch_candidate.rejected",
  "skill_candidate.approved",
  "skill_candidate.rejected",
  "approval.granted",
  "approval.approved",
  "approval.rejected",
  "approval.declined",
  "workflow.authority_granted",
  "workflow.authority_revoked",
  "workflow.authority_expiry_removed",
  "policy.denied",
  "approval.dispatch_denied",
  "execution.boundary_refused",
  "rbac.role_created",
  "rbac.role_deleted",
  "rbac.permission_granted",
  "rbac.permission_revoked",
  "rbac.user_role_assigned",
  "rbac.user_role_revoked",
  "user.created",
  "user.deleted",
  "user.role_changed",
  "api_key.issued",
  "api_key.revoked",
  "workflow.deleted",
  "workflow.version_restored",
  "knowledge_source.restored",
  "schedule.created",
  "schedule.deleted",
  "connector.deleted",
  "secret.version_created",
  "secret.version_revoked",
  "settings.changed",
] as const;

function identifierParam(params: URLSearchParams, key: string): string | null {
  const raw =
    params.get(key)?.trim() ??
    // Stryker disable next-line StringLiteral: EQ-AUDIT-ABSENT: absent invalid filter sentinel
    "";
  return raw && raw.length <= 128 && /^[\w.:-]+$/.test(raw) ? raw : null;
}

function instantParam(params: URLSearchParams, key: string): string | null {
  const raw =
    params.get(key)?.trim() ??
    // Stryker disable next-line StringLiteral: EQ-AUDIT-ABSENT: absent invalid filter sentinel
    "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function isAuditScope(value: unknown): value is AuditScope {
  return value === "all" || value === "decisions" || value === "operations";
}

export function auditScopeParams(scope: AuditScope): Record<string, string> {
  if (scope === "decisions") return { action: DECISION_ACTIONS.join(",") };
  if (scope === "operations") return { actor_type: "system" };
  return {};
}

export function normalizedAuditScope(
  scope: AuditScope,
  action: string,
  actorType: string,
): AuditScope {
  if (
    scope === "decisions" &&
    action &&
    action.split(",").some((item) => !DECISION_ACTIONS.includes(item as never))
  )
    return "all";
  if (scope === "operations" && actorType && actorType !== "system") return "all";
  return scope;
}

export function auditTraceFromUrl(search: string): string | null {
  const raw =
    new URLSearchParams(search).get("trace_id")?.trim() ??
    // Stryker disable next-line StringLiteral: EQ-AUDIT-ABSENT: absent invalid filter sentinel
    "";
  return raw && raw.length <= 128 && /^[\w-]+$/.test(raw) ? raw : null;
}

export function auditCorrelationFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("correlation_id");
  return raw && /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}

const MAX_LINKED_ACTIONS = 32;
const ACTION_TOKEN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function auditActionsFromUrl(search: string): string[] {
  const tokens = (
    new URLSearchParams(search).get("action") ??
    // Stryker disable next-line StringLiteral: EQ-AUDIT-ABSENT: absent invalid filter sentinel
    ""
  )
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length <= 96 && ACTION_TOKEN.test(token));
  return [...new Set(tokens)].slice(0, MAX_LINKED_ACTIONS);
}

const AUDIT_RESULTS = ["success", "denied", "error"] as const;
type AuditResultFilter = (typeof AUDIT_RESULTS)[number];

export function auditResultFromUrl(search: string): AuditResultFilter | null {
  const raw = new URLSearchParams(search).get("result");
  return (AUDIT_RESULTS as readonly string[]).includes(
    raw ??
      // Stryker disable next-line StringLiteral: EQ-AUDIT-ABSENT: absent invalid filter sentinel
      "",
  )
    ? (raw as AuditResultFilter)
    : null;
}

export function auditFilterFromUrl(search: string): AuditLinkFilter {
  const params = new URLSearchParams(search);
  const resourceType = identifierParam(params, "resource_type");
  const scope = params.get("scope");
  return {
    resourceType,
    resourceId: resourceType ? identifierParam(params, "resource_id") : null,
    traceId: auditTraceFromUrl(search),
    scope: isAuditScope(scope) ? scope : null,
    actions: auditActionsFromUrl(search),
    tsFrom: instantParam(params, "ts_from"),
    tsTo: instantParam(params, "ts_to"),
  };
}

export function auditLinkParams(filter: AuditLinkFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.resourceType) params.resource_type = filter.resourceType;
  if (filter.resourceId) params.resource_id = filter.resourceId;
  if (filter.traceId) params.trace_id = filter.traceId;
  if (filter.actions.length > 0) params.action = filter.actions.join(",");
  if (filter.tsFrom) params.ts_from = filter.tsFrom;
  if (filter.tsTo) params.ts_to = filter.tsTo;
  return params;
}

export function initialAuditFilter(search: string, now: number): AuditLinkFilter {
  const filter = auditFilterFromUrl(search);
  if (
    filter.tsFrom ||
    filter.tsTo ||
    filter.traceId ||
    filter.resourceId ||
    auditCorrelationFromUrl(search)
  )
    return filter;
  return { ...filter, tsFrom: new Date(now - 30 * 86_400_000).toISOString() };
}

function hasExplicitAuditWindow(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("ts_from") || params.has("ts_to");
}

export function auditCountKey(
  search: string,
  filter: AuditLinkFilter,
  count: number,
  hasNextPage: boolean,
) {
  const defaultWindow =
    filter.tsFrom !== null &&
    filter.tsTo === null &&
    !hasExplicitAuditWindow(search) &&
    filter.traceId === null &&
    filter.resourceId === null &&
    auditCorrelationFromUrl(search) === null;
  if (defaultWindow)
    return hasNextPage
      ? "audit.countWindowMore"
      : count === 1
        ? "audit.countWindow.one"
        : "audit.countWindow";
  return hasNextPage ? "audit.countMore" : count === 1 ? "audit.count.one" : "audit.count";
}

export const AUDIT_AREAS = {
  all: [],
  runs: ["execution", "execution_step"],
  workflows: ["workflow", "workflow_version", "workflow_execution_authority", "workflow_schedule"],
  connectors: ["connector", "credential", "connection"],
  knowledge: ["knowledge_source", "knowledge_source_version", "skill", "skill_candidate"],
  files: ["file"],
  conversations: ["conversation", "conversation_elicitation"],
  people: [
    "user",
    "user_identity",
    "group",
    "role",
    "resource_grant",
    "api_key",
    "system_account",
    "mcp_oauth_client",
  ],
} as const;

export type AuditArea = keyof typeof AUDIT_AREAS;

export function auditAreaParams(area: AuditArea): Record<string, string> {
  return area === "all" ? {} : { resource_types: AUDIT_AREAS[area].join(",") };
}
