// Credential HTTP surface — tenant-facing.
//
// Most credential lifecycle operations are driven through
// `POST /v1/connectors/:id/credentials` (create) or the oauth2 callback.
// This module adds the missing `POST /v1/credentials/:id/rotate` endpoint
// so operators can force a rotation without waiting for the inline
// refresh worker to observe expiry.
//
// Behaviour:
//   * `oauth2` credentials: runs the refresh grant using the parent
//     connector's oauth2 config and persists the new access + refresh
//     tokens via `rotateOAuth2Tokens`, which also writes the
//     `credential.rotated` audit row.
//   * Plain credentials (`bearer`, `basic`, `header`, `query`): rejected
//     with a typed `cannot_rotate_plain_credential` error. Manual
//     credentials have no way to derive a new secret server-side, so
//     rotation has to go through the `POST /v1/connectors/:id/credentials`
//     write path with a fresh payload.
//
// RBAC: gated on `credential:rotate`.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import * as connectorSvc from "../../connectors/index.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/index.ts";
import {
  getCredentialForConnector,
  rotateOAuth2Tokens,
  runRefreshTokenGrant,
} from "../../credentials/index.ts";
import { credentials } from "../../db/schema/index.ts";
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

export function registerCredentialRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/credentials/:id/rotate", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:rotate", () => ({ type: "credential", id }))(c, next);
  });

  app.openapi(rotateRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    // Load the credential row first to figure out which rotation path
    // applies + to resolve the parent connector.
    const rows = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, principal.tenant_id), eq(credentials.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("credential");

    if (row.mode !== "oauth2") {
      throw new BadRequestError("cannot_rotate_plain_credential", {
        mode: row.mode,
        hint: "POST /v1/connectors/:id/credentials with a new payload",
      });
    }

    // This route rotates connector-owned oauth2 credentials. MCP-server
    // credentials (connector_id null) are not rotatable here — their
    // refresh path is driven through the MCP client subsystem.
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

    // Decrypt the current refresh token via the service so AAD logic
    // lives in one place. `getCredentialForConnector` handles the
    // refresh triple.
    const fetched = await getCredentialForConnector(
      principal.tenant_id,
      connectorId,
      row.environment as "dev" | "prod",
      db,
    );
    if (!fetched || fetched.value.mode !== "oauth2") {
      throw new BadRequestError("credential is not in oauth2 mode");
    }
    if (!fetched.value.refresh_token) {
      throw new BadRequestError("oauth2 credential has no refresh token to rotate");
    }

    const bundle = await runRefreshTokenGrant(cfg, fetched.value.refresh_token);
    await rotateOAuth2Tokens(
      {
        tenant_id: principal.tenant_id,
        credential_id: id,
        access_token: bundle.access_token,
        token_type: bundle.token_type,
        scope: bundle.scope ?? undefined,
        refresh_token: bundle.refresh_token ?? fetched.value.refresh_token,
        expires_at: bundle.expires_at,
        actor_id: principal.id,
      },
      db,
    );

    // Re-fetch metadata for the response envelope. We deliberately do
    // NOT return plaintext here — this endpoint is a compliance surface.
    const updatedRows = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, principal.tenant_id), eq(credentials.id, id)))
      .limit(1);
    const updated = updatedRows[0];
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
