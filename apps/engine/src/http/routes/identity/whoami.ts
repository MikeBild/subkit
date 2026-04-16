// GET /v1/identity/whoami — returns identity info about the caller.
//
// Used by the `sk` CLI to populate the status line on startup with
// the effective tenant, role, and email. The response carries just
// enough to render a persona banner without issuing a second probe.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { roles, systemAccounts, tenants, users } from "../../../db/schema/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const WhoamiSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["user", "system_account"]),
    tenant_id: z.string(),
    tenant_slug: z.string().nullable(),
    email: z.string().nullable(),
    role_name: z.string().nullable(),
    provider: z.string(),
  })
  .openapi("Whoami");

const route = createRoute({
  method: "get",
  path: "/v1/identity/whoami",
  tags: ["identity"],
  summary: "Return identity info about the authenticated caller",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: WhoamiSchema } },
    },
  },
});

export function registerWhoamiRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    let email: string | null = null;
    let roleName: string | null = null;

    if (principal.kind === "user") {
      const [row] = await db
        .select({
          email: users.email,
          role_legacy: users.role,
          role_name: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(eq(users.id, principal.id))
        .limit(1);
      email = row?.email ?? null;
      roleName = row?.role_name ?? row?.role_legacy ?? null;
    } else if (principal.kind === "system_account") {
      const [row] = await db
        .select({
          role_name: roles.name,
        })
        .from(systemAccounts)
        .leftJoin(roles, eq(roles.id, systemAccounts.role_id))
        .where(eq(systemAccounts.id, principal.id))
        .limit(1);
      roleName = row?.role_name ?? null;
    }

    const [tenantRow] = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, principal.tenant_id))
      .limit(1);

    return c.json(
      {
        id: principal.id,
        kind: principal.kind as "user" | "system_account",
        tenant_id: principal.tenant_id,
        tenant_slug: tenantRow?.slug ?? null,
        email,
        role_name: roleName,
        provider: principal.provider,
      },
      200,
    );
  });
}
