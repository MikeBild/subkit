// RBAC management API — entry point.
//
// The former http/routes/rbac.ts split into per-resource modules; this
// barrel registers each. Public API unchanged: server.ts still calls
// `registerRbacRoutes(app)`.
//
// All mutations write an audit row. All mutations require
// `rbac:write`. Listing + `can` queries require `rbac:read`.
// Built-in roles are read-only; mutating them returns 409 with code
// `builtin_role_immutable`.
//
//   GET    /v1/rbac/permissions
//   GET    /v1/rbac/roles
//   GET    /v1/rbac/roles/:id
//   POST   /v1/rbac/roles
//   PATCH  /v1/rbac/roles/:id
//   DELETE /v1/rbac/roles/:id
//   POST   /v1/rbac/roles/:id/permissions
//   DELETE /v1/rbac/roles/:id/permissions/:permission
//   POST   /v1/rbac/users/:user_id/role
//   GET    /v1/rbac/grants
//   POST   /v1/rbac/grants
//   DELETE /v1/rbac/grants/:id
//   GET    /v1/rbac/groups
//   POST   /v1/rbac/groups
//   PATCH  /v1/rbac/groups/:id
//   DELETE /v1/rbac/groups/:id
//   POST   /v1/rbac/groups/:id/members/:user_id
//   DELETE /v1/rbac/groups/:id/members/:user_id
//   POST   /v1/rbac/groups/:id/roles/:role_id
//   DELETE /v1/rbac/groups/:id/roles/:role_id
//   POST   /v1/rbac/can

import type { OpenAPIHono } from "@hono/zod-openapi";

import type { AppEnv } from "../../openapi.ts";
import { registerCanRoutes } from "./can.ts";
import { registerGrantsRoutes } from "./grants.ts";
import { registerGroupsRoutes } from "./groups.ts";
import { registerPermissionsRoutes } from "./permissions.ts";
import { registerRolesRoutes } from "./roles.ts";

export function registerRbacRoutes(app: OpenAPIHono<AppEnv>): void {
  registerPermissionsRoutes(app);
  registerRolesRoutes(app);
  registerGrantsRoutes(app);
  registerGroupsRoutes(app);
  registerCanRoutes(app);
}
