// Single source of truth for the permission set the sk CLI gates UX
// surfaces on (slash-menu visibility, persona probe). Owned by the
// rbac/ subsystem because the engine evaluates these in
// `GET /v1/sk/bootstrap`; the CLI consumes them via the wire response,
// the legacy persona-probe consumes them via the constant exported
// here, and tests assert against this same constant. Three copies →
// one constant. Renaming a permission in one place forces the rename
// here and the corresponding routes / probes notice it at type-check
// time rather than at the next test run.

export const UX_GATING_PERMISSIONS = [
  // Tier 1 — every authenticated principal
  "conversation:read",
  "conversation:write",
  "memory:write",
  // Tier 2 — member
  "conversation:approve",
  "conversation:list",
  "mcp:read",
  "skill:read",
  // Tier 3 — operator
  "conversation:cancel",
  "conversation:commit",
  "workflow:read",
  "workflow:write",
  "connector:read",
  "skill:write",
  "execution:read",
  "notification:read",
  // Tier 4 — admin
  "audit:read",
  "identity:read",
  "rbac:read",
  "api_key:read",
  "portal_token:read",
  "knowledge:read",
] as const;

export type UxGatingPermission = (typeof UX_GATING_PERMISSIONS)[number];
