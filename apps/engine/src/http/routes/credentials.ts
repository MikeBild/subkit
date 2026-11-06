import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import * as connectorSvc from "../../connectors/index.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/index.ts";
import {
  credentialExists,
  deleteCredential,
  findLiveCredential,
  getCredentialForConnector,
  rotateOAuth2Tokens,
  runRefreshTokenGrant,
} from "../../credentials/index.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const CredentialRowSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    connector_id: z.string(),
    environment: z.string(),
    mode: z.string(),
    oauth2_expires_at: z.string().nullable(),
    updated_at: z.string(),
  })
  .openapi("CredentialRow");

const rotateRouteSpec = createRoute({
  method: "post",
  path: "/v1/credentials/{id}/rotate",
  tags: ["credentials"],
  summary: "Rotate a credential",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({}).optional() } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: CredentialRowSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRouteSpec = createRoute({
  method: "delete",
  path: "/v1/credentials/{id}",
  tags: ["credentials"],
  summary: "Delete a credential",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: z.object({ deleted: z.literal(true) }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCredentialRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/credentials/:id/rotate", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:rotate", () => ({ type: "credential", id }))(c, next);
  });

  app.use("/v1/credentials/:id", async (c, next) => {
    if (c.req.method !== "DELETE") return next();
    const id = c.req.param("id");
    return requirePermission("credential:delete", () => ({ type: "credential", id }))(c, next);
  });

  app.openapi(deleteRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    if (!(await credentialExists(db, principal.tenant_id, id))) {
      throw new NotFoundError("credential");
    }

    await deleteCredential(principal.tenant_id, id, actorOf(principal), db);
    return c.json({ deleted: true as const }, 200);
  });

  app.openapi(rotateRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    const row = await findLiveCredential(db, principal.tenant_id, id);
    if (!row) throw new NotFoundError("credential");

    if (row.mode !== "oauth2") {
      throw new BadRequestError("cannot_rotate_plain_credential", {
        mode: row.mode,
        hint: "POST /v1/connectors/:id/credentials with a new payload",
      });
    }

    if (row.connector_id == null) {
      throw new BadRequestError("cannot_rotate_non_connector_credential", {
        hint: "credential is not owned by a connector",
      });
    }
    const connectorId = row.connector_id;

    const connector = await connectorSvc.getConnector(principal.tenant_id, connectorId, db);
    if (!connector) throw new NotFoundError("connector");

    const cfg = await resolveConnectorOAuthConfig(db, principal.tenant_id, connector);
    if (!cfg) {
      throw new BadRequestError("connector is missing oauth2 config (issuer_url + client_id)");
    }

    const fetched = await getCredentialForConnector(
      principal.tenant_id,
      connectorId,
      row.environment as "dev" | "prod",
      db,
    );
    if (fetched?.value.mode !== "oauth2") {
      throw new BadRequestError("credential is not in oauth2 mode");
    }
    if (!fetched.value.refresh_token) {
      throw new BadRequestError("oauth2 credential has no refresh token to rotate");
    }

    const bundle = await runRefreshTokenGrant(cfg, fetched.value.refresh_token, {
      tenant_id: principal.tenant_id,
      exec: db,
    });
    await rotateOAuth2Tokens(
      {
        tenant_id: principal.tenant_id,
        credential_id: id,
        expected_generation: fetched.row.credential_generation,
        access_token: bundle.access_token,
        verified_identity: bundle.verified_identity ?? null,
        token_type: bundle.token_type,
        scope: bundle.scope ?? undefined,
        refresh_token: bundle.refresh_token ?? fetched.value.refresh_token,
        expires_at: bundle.expires_at,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      db,
    );

    const updated = await findLiveCredential(db, principal.tenant_id, id);
    if (!updated) throw new NotFoundError("credential");

    return c.json(
      {
        id: updated.id,
        tenant_id: updated.tenant_id,
        connector_id: connectorId,
        environment: updated.environment,
        mode: updated.mode,
        oauth2_expires_at: updated.oauth2_expires_at
          ? updated.oauth2_expires_at.toISOString()
          : null,
        updated_at: updated.updated_at.toISOString(),
      },
      200,
    );
  });
}
