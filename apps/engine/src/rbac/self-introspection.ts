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
  // POST /v1/identity/login (issues a session — auth side, not RBAC side)
  "identity-login",
  // POST /v1/identity/sessions (provider assertion exchange)
  "identity-sessions",
  // POST /v1/identity/cli-session (dedicated OAuth audience+scope exchange;
  // authenticated before an API principal exists, so RBAC cannot gate it)
  "identity-cli-session",
  // GET /v1/identity/providers (the sign-in inventory — public by family rule
  // of 2026-09-04: the caller who has no credential yet is exactly the caller
  // who needs to know which credentials exist, so RBAC cannot gate it. It
  // answers protocol, opaque id and a generic label per protocol; no issuer,
  // client id, scope list or operator wording)
  "identity-providers",
  // GET /healthz, /health (liveness, no auth needed)
  "health",
  // GET /metrics (prometheus, gated by auth-middleware-only)
  "metrics",
] as const);

export type SelfIntrospectionRoute = (typeof SELF_INTROSPECTION_ROUTES)[number];
