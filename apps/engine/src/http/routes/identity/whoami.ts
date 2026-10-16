import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { roles, systemAccounts, tenants, users } from "../../../db/schema/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";
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
    base_url: z.string().nullable(),
    scopes: z.array(z.string()).nullable(),
    product_id: z
      .string()
      .nullable()
      .describe("App the caller signed in to through an oidc_bearer provider, or null"),
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
          role_name: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(and(eq(users.tenant_id, principal.tenant_id), eq(users.id, principal.id)))
        .limit(1);
      email = row?.email ?? null;
      roleName = row?.role_name ?? null;
    } else if (principal.kind === "system_account") {
      const [row] = await db
        .select({
          role_name: roles.name,
        })
        .from(systemAccounts)
        .leftJoin(roles, eq(roles.id, systemAccounts.role_id))
        .where(
          and(
            eq(systemAccounts.tenant_id, principal.tenant_id),
            eq(systemAccounts.id, principal.id),
          ),
        )
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
        base_url: resolveEngineUrl(c.req.raw) ?? null,
        scopes: Array.isArray(principal.scopes) ? principal.scopes : null,
        product_id: principal.product_id ?? null,
      },
      200,
    );
  });
}
