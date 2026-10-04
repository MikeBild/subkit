import type { ConnectorAccessLevel, DenyDetail } from "./evaluator.ts";

function levelLabel(level: ConnectorAccessLevel): string {
  if (level === "read-write") return "read-write access";
  if (level === "read-only") return "read-only access";
  return "no access";
}

function needsLabel(required: string): string {
  return required === "connector:read" ? "read access" : "read-write access";
}

export function denialHint(detail: DenyDetail | undefined, level?: ConnectorAccessLevel): string {
  if (!detail) {
    return "this action requires a permission you do not hold; ask an admin for a grant or a scoped key";
  }
  const { required, resource, cause } = detail;
  if (resource?.type === "connector" && level) {
    return `you have ${levelLabel(level)} to connector ${resource.id}; this needs ${needsLabel(required)} — request a grant or a key with that access`;
  }
  const on = resource ? ` on ${resource.type} ${resource.id}` : "";
  if (cause.startsWith("credential_ceiling:")) {
    return `your credential is scoped and does not permit ${required}${on}; use a key or grant that includes it`;
  }
  return `you lack ${required}${on}; request a grant or a key with that permission`;
}

export function denialDetails(
  detail: DenyDetail | undefined,
  level?: ConnectorAccessLevel,
): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  return {
    required: detail.required,
    ...(detail.resource ? { resource: detail.resource } : {}),
    cause: detail.cause,
    ...(level ? { connector_level: level } : {}),
  };
}
