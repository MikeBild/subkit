// Actionable denial rendering (Stream 2).
//
// `can()` returns a `Decision` whose optional `detail` carries the
// machine-readable shape of a deny (required permission, resource, cause).
// These helpers turn that into a human, actionable hint and a structured
// details bag, rendered identically on REST, MCP/chat, and the CLI so a
// builder always learns WHAT they lacked and HOW to get it.
//
// The connector access LEVEL (none/read-only/read-write) is computed by the
// caller via `connectorAccessLevel` (it needs the db) and threaded in — these
// helpers stay pure so every surface can share them.

import type { ConnectorAccessLevel, DenyDetail } from "./evaluator.ts";

function levelLabel(level: ConnectorAccessLevel): string {
  if (level === "read-write") return "read-write access";
  if (level === "read-only") return "read-only access";
  return "no access";
}

function needsLabel(required: string): string {
  return required === "connector:read" ? "read access" : "read-write access";
}

/** Operator-facing, actionable one-liner. Surfaced verbatim as the HTTP
 *  `hint`, the MCP error detail, and the CLI hint. */
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

/** Structured details bag for the HTTP 403 envelope / MCP `details`. */
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
