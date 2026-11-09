export type PermissionDecisionSource =
  | "builtin_admin"
  | "resource_grant"
  | "group"
  | "role"
  | "portal_token_allowlist"
  | "credential_ceiling"
  | "operator_boundary";

export interface PermissionRequest {
  permission: string;
  resource?: { type: string; id: string };
  portal_token: boolean;
  portal_workflow_allowlist?: readonly string[] | "all";
}

export interface PermissionFacts {
  credential_ceiling_cause?: string;
  operator_allowed: boolean;
  builtin_admin: boolean;
  permission_known: boolean;
  resource_grant: boolean;
  group_grant: boolean;
  role_grant: boolean;
}

export interface CredentialCeilingFacts {
  product_limited: boolean;
  product_permission_allowed: boolean;
  scope_limited: boolean;
  scope_allows_permission: boolean;
  connector_allowlist?: readonly string[] | "all";
  workflow_allowlist?: readonly string[] | "all";
}

export function credentialCeilingCause(
  request: Pick<PermissionRequest, "permission" | "resource">,
  facts: CredentialCeilingFacts,
): string | null {
  if (facts.product_limited && !facts.product_permission_allowed)
    return "product_permission_not_granted";
  if (facts.scope_limited && !facts.scope_allows_permission) return "scope_not_granted";
  if (
    request.resource?.type === "connector" &&
    facts.connector_allowlist &&
    facts.connector_allowlist !== "all" &&
    !facts.connector_allowlist.includes(request.resource.id)
  )
    return "connector_not_in_allowlist";
  if (
    request.resource?.type === "workflow" &&
    facts.workflow_allowlist &&
    facts.workflow_allowlist !== "all" &&
    !facts.workflow_allowlist.includes(request.resource.id)
  )
    return "workflow_not_in_allowlist";
  return null;
}

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
  source?: PermissionDecisionSource;
  detail?: { required: string; resource?: { type: string; id: string }; cause: string };
}

function deny(
  request: PermissionRequest,
  source: PermissionDecisionSource | undefined,
  reason: string,
  cause?: string,
): PermissionDecision {
  return {
    allow: false,
    reason,
    ...(source ? { source } : {}),
    detail: {
      required: request.permission,
      ...(request.resource ? { resource: request.resource } : {}),
      cause: cause ?? reason,
    },
  };
}

export function matchesPortalTokenAllowlist(request: PermissionRequest): boolean {
  if (!request.portal_token) return false;
  const allow = request.portal_workflow_allowlist;
  if (allow === undefined) return false;
  if (request.permission === "workflow:run" || request.permission === "workflow:read")
    return (
      request.resource?.type === "workflow" &&
      (allow === "all" || (Array.isArray(allow) && allow.includes(request.resource.id)))
    );
  return (
    (request.permission === "conversation:read" ||
      request.permission === "conversation:write" ||
      request.permission === "conversation:cancel") &&
    (allow === "all" || (Array.isArray(allow) && allow.length > 0))
  );
}

export function credentialCeilingDecision(
  request: PermissionRequest,
  facts: Pick<PermissionFacts, "credential_ceiling_cause">,
): PermissionDecision | null {
  const cause = facts.credential_ceiling_cause;
  return cause
    ? deny(
        request,
        "credential_ceiling",
        `credential_ceiling:${cause}`,
        `credential_ceiling:${cause}`,
      )
    : null;
}

export function evaluatePermission(
  request: PermissionRequest,
  facts: PermissionFacts,
): PermissionDecision {
  const ceiling = credentialCeilingDecision(request, facts);
  if (ceiling) return ceiling;
  if (!facts.operator_allowed)
    return deny(request, "operator_boundary", "operator_boundary:operator_only", "operator_only");
  if (facts.builtin_admin) return { allow: true, source: "builtin_admin" };
  if (!facts.permission_known)
    return { allow: false, reason: `permission_unknown:${request.permission}` };
  if (!request.portal_token && facts.resource_grant)
    return { allow: true, source: "resource_grant" };
  if (!request.portal_token && facts.group_grant) return { allow: true, source: "group" };
  if (!request.portal_token && facts.role_grant) return { allow: true, source: "role" };
  if (matchesPortalTokenAllowlist(request))
    return { allow: true, source: "portal_token_allowlist" };
  const portalWorkflow =
    request.portal_token &&
    (request.permission === "workflow:run" || request.permission === "workflow:read");
  return deny(
    request,
    undefined,
    portalWorkflow ? "workflow_not_in_allowlist" : `permission_denied:${request.permission}`,
    request.portal_token ? "workflow_not_in_allowlist" : "no_matching_grant",
  );
}

export function deriveConnectorAccessLevel(
  read: PermissionDecision,
  write: PermissionDecision,
): "none" | "read-only" | "read-write" {
  return write.allow ? "read-write" : read.allow ? "read-only" : "none";
}

export interface ResourceAccessFacts {
  readonly portal_token: boolean;
  readonly permission: string;
  readonly resource_type: string;
  readonly workflow_allowlist?: readonly string[] | "all";
  readonly connector_allowlist?: readonly string[] | "all";
  readonly granted_ids: readonly string[];
}

export function evaluateResourceAccess<T extends PermissionDecision>(
  tenantWide: T,
  facts: ResourceAccessFacts,
): { tenantWide: T; allows: (id: string) => boolean; any: boolean } {
  if (tenantWide.source === "credential_ceiling" || tenantWide.source === "operator_boundary")
    return { tenantWide, allows: () => false, any: false };
  const list =
    facts.resource_type === "workflow"
      ? facts.workflow_allowlist
      : facts.resource_type === "connector"
        ? facts.connector_allowlist
        : undefined;
  const ceilingAllows = (id: string): boolean =>
    facts.portal_token || !list || list === "all" || list.includes(id);
  if (tenantWide.allow) return { tenantWide, allows: ceilingAllows, any: true };
  const granted = new Set(facts.granted_ids);
  const allows = (id: string): boolean => {
    if (!ceilingAllows(id)) return false;
    if (granted.has(id)) return true;
    return matchesPortalTokenAllowlist({
      permission: facts.permission,
      portal_token: facts.portal_token,
      ...(facts.workflow_allowlist !== undefined
        ? { portal_workflow_allowlist: facts.workflow_allowlist }
        : {}),
      resource: { type: facts.resource_type, id },
    });
  };
  const allowlist = facts.workflow_allowlist;
  const portalReaches =
    facts.portal_token &&
    (facts.permission === "workflow:read" || facts.permission === "workflow:run") &&
    facts.resource_type === "workflow" &&
    (allowlist === "all" || (Array.isArray(allowlist) && allowlist.length > 0));
  return { tenantWide, allows, any: granted.size > 0 || portalReaches };
}
