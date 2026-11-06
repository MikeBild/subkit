import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { loadWhoamiProfile } from "../../../identity/index.ts";
import { resolveEngineUrl } from "../../../llm/index.ts";
import { isOperatorPrincipal } from "../../../rbac/index.ts";
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
    engine_operator: z
      .boolean()
      .describe("True when the caller belongs to the engine operator workspace"),
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

    const profile = await loadWhoamiProfile(db, principal);

    return c.json(
      {
        id: principal.id,
        kind: principal.kind as "user" | "system_account",
        tenant_id: principal.tenant_id,
        tenant_slug: profile.tenant_slug,
        email: profile.email,
        role_name: profile.role_name,
        provider: principal.provider,
        base_url: resolveEngineUrl(c.req.raw) ?? null,
        scopes: Array.isArray(principal.scopes) ? principal.scopes : null,
        product_id: principal.product_id ?? null,
        engine_operator: await isOperatorPrincipal(db, principal),
      },
      200,
    );
  });
}
