// Scope gate for routes that are auth'd but require a specific OAuth-style
// scope token (e.g. `metrics:read`).
//
// The rule, stated once so a person and a machine can read the same thing:
//
//   A credential that names a narrow scope list is BOUNDED by that list. Its
//   owner's role can never widen it. Only a credential that asserts no
//   narrowing — the `*` wildcard scope, or no scope list at all (a browser
//   session, an OIDC session) — falls back to the role check, where `admin`
//   passes. That is the same wildcard/ceiling split the RBAC evaluator
//   applies (`auth/scopes.ts`, `rbac/evaluator.ts`).
//
// The role bypass used to apply to every principal, which made the scope
// decorative for anything an admin held. Production measured it on
// 2026-09-04: a Cockpit connection token whose grant said only `mcp:read`
// read `/metrics`, because the person who approved the connection happened
// to be an admin. A delegated token that says `mcp:read` must mean `mcp:read`
// — the whole point of showing a scope list on a consent screen is that the
// list is the answer.
//
// `mcp:*` scopes are catalog-mode markers rather than permissions, so they
// impose no RBAC ceiling. That is deliberate there and exactly why it cannot
// be relied on here: `/metrics` asks for one named scope and takes nothing
// else as a substitute.
//
// Denials are recorded as `policy.denied` audit rows with a structured
// `reason: "scope_missing:<scope>"` so operators can see exactly which
// route turned the request away. 401 is raised for missing principals
// and 403 for authenticated principals that lack the scope.

import type { MiddlewareHandler } from "hono";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { WILDCARD_SCOPE } from "../../auth/scopes.ts";
import { ForbiddenError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    // `undefined` means "no scope restriction was attached to this
    // credential" and `*` means "narrow me by nothing" — both fall back to the
    // role check. An empty array is a scope list that grants nothing and stays
    // a denial.
    const scopeBound = principal.scopes !== undefined && !principal.scopes.includes(WILDCARD_SCOPE);
    const isAdmin = !scopeBound && principal.roles.includes("admin");
    const hasScope = principal.scopes?.includes(scope) ?? false;
    if (!isAdmin && !hasScope) {
      // Bind the audit write to the same request-scoped db handle so
      // tests with a per-suite disposable database observe the row.
      const db = c.get("db");
      audit(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "user" ? "user" : "system_account",
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: "scope",
          resource_id: scope,
          result: "denied",
          reason: `scope_missing:${scope}`,
          metadata: {
            method: c.req.method,
            path: c.req.path,
            required_scope: scope,
            scope_bound: scopeBound,
          },
        },
        db,
      );
      throw new ForbiddenError(`scope_missing:${scope}`);
    }
    await next();
  };
}
