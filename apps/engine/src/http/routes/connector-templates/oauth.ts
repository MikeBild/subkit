// Tenant-scoped OAuth client credentials for a connector template:
//   POST /v1/connector-templates/{slug}/oauth-credentials

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  resolveConnectorTemplate,
  upsertTemplateOAuthCredentials,
} from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  requireAdmin,
  TemplateOAuthCredentialBody,
  TemplateOAuthCredentialResponse,
  TemplateSlugParam,
} from "./schemas.ts";

const templateOauthCredentialRoute = createRoute({
  method: "post",
  path: "/v1/connector-templates/{slug}/oauth-credentials",
  tags: ["connectors"],
  summary: "Store tenant-scoped OAuth client credentials for a connector template",
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateSlugParam,
    body: { content: { "application/json": { schema: TemplateOAuthCredentialBody } } },
  },
  responses: {
    200: {
      description: "Stored",
      content: { "application/json": { schema: TemplateOAuthCredentialResponse } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(templateOauthCredentialRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { slug } = c.req.valid("param");
    const body = c.req.valid("json");
    const resolved = await resolveConnectorTemplate({
      db,
      tenant_id: principal.tenant_id,
      slug,
    });
    if (!resolved) throw new NotFoundError("connector_template");
    const row = await upsertTemplateOAuthCredentials(
      {
        tenant_id: principal.tenant_id,
        template_slug: slug,
        value: {
          client_id: body.client_id,
          client_secret: body.client_secret,
        },
        actor_id: principal.id,
      },
      db,
    );
    return c.json(row, 200);
  });
}
