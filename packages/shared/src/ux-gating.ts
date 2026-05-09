// Single source of truth for the permission set the `sk` CLI gates UX
// surfaces on (slash-menu visibility, persona probe). Lives in
// `packages/shared/` so engine + CLI + tests all import the same
// literal-typed array — drift is caught at typecheck, not at runtime.
//
// The engine evaluates these in `GET /v1/sk/bootstrap`. The legacy
// tiered persona-probe in `apps/sk/src/persona-probe.ts` consumes the
// same set as a flat allow-list. Tests assert against this constant.
//
// Tiers below match the legacy probe ladder for the comments only —
// the actual permission decision is per-permission via `can()`, never
// "tier reached".

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
  "connector:write",
  "skill:write",
  "execution:read",
  "notification:read",
  "notification:write",
  "discovery:read",
  // Tier 4 — admin
  "audit:read",
  "identity:read",
  "rbac:read",
  "api_key:read",
  "portal_token:read",
  "knowledge:read",
] as const;

export type UxGatingPermission = (typeof UX_GATING_PERMISSIONS)[number];
