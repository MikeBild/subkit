// Canonical list of routes that intentionally skip `requirePermission(...)`.
//
// These are the *self-introspection* routes — the ones an
// authenticated principal needs to call BEFORE they can be told
// which permissions they have. Gating them on a permission would
// create a chicken-and-egg problem (you can't discover that you
// have any permissions if discovery itself requires one).
//
// The list is the contract surface: a unit test in
// `apps/engine/src/http/tests/self-introspection-carve-out.test.ts`
// asserts that exactly these routes (and no others) ship without an
// explicit permission. Adding a new state-mutating route under
// `identity/` does NOT inherit the carve-out automatically — the
// test will fail until the route either declares a permission or is
// added to this list.

export const SELF_INTROSPECTION_ROUTES = Object.freeze([
  // GET /v1/identity/whoami
  "whoami",
  // GET /v1/identity/permissions (a caller's own effective rights on a
  // resource — must be reachable before any permission is known to be held)
  "identity-permissions",
  // GET /v1/sk/bootstrap
  "sk-bootstrap",
  // GET /v1/cockpit/bootstrap
  "cockpit-bootstrap",
  // GET /v1/identity/providers (lists which auth providers are configured)
  "identity-providers",
  // POST /v1/identity/login (issues a session — auth side, not RBAC side)
  "identity-login",
  // POST /v1/identity/sessions (provider assertion exchange)
  "identity-sessions",
  // GET /healthz, /v1/health (liveness, no auth needed)
  "health",
  // GET /metrics (prometheus, gated by auth-middleware-only)
  "metrics",
] as const);

export type SelfIntrospectionRoute = (typeof SELF_INTROSPECTION_ROUTES)[number];
