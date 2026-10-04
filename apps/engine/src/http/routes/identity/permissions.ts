import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { computeConnectorScopeDiff, getConnector } from "../../../connectors/index.ts";
import { connectorAccessLevel } from "../../../rbac/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const ConnectorScopeDiffSchema = z
  .object({
    partial_grant: z.union([z.boolean(), z.literal("unknown")]),
    expected: z.array(z.string()),
    granted: z.array(z.string()),
    missing: z.array(z.string()),
    note: z.string().optional(),
  })
  .nullable();

const PermissionsSchema = z
  .object({
    resource_type: z.literal("connector"),
    resource_id: z.string(),
    level: z.enum(["none", "read-only", "read-write"]),
    credential_scopes: ConnectorScopeDiffSchema,
  })
  .openapi("EffectivePermissions");

const QuerySchema = z.object({
  resource_type: z.literal("connector"),
  resource_id: z.string().min(1),
});

const route = createRoute({
  method: "get",
  path: "/v1/identity/permissions",
  tags: ["identity"],
  summary: "Effective permissions of the authenticated caller on a resource",
  security: [{ bearerAuth: [] }],
  request: { query: QuerySchema },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: PermissionsSchema } },
    },
  },
});

export function registerEffectivePermissionsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { resource_id } = c.req.valid("query");

    const level = await connectorAccessLevel(db, principal, resource_id, principal.tenant_id);

    const connector = await getConnector(principal.tenant_id, resource_id, db);
    const credentialScopes = connector
      ? await computeConnectorScopeDiff(db, principal.tenant_id, connector)
      : null;

    return c.json(
      {
        resource_type: "connector" as const,
        resource_id,
        level,
        credential_scopes: credentialScopes,
      },
      200,
    );
  });
}
