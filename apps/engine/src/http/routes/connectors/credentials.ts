// Credential attachment for a connector:
//   POST /v1/connectors/{id}/credentials             — non-oauth credential
//   POST /v1/connectors/{id}/end-user-credentials    — end-user-scoped

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { runClientCredentialsGrant } from "../../../credentials/index.ts";
import { encryptSecret } from "../../../crypto/aes-gcm.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { credentialBodyToValue } from "./credential-body.ts";
import { CredentialBody } from "./schemas.ts";

const credentialsRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/credentials",
  tags: ["connectors"],
  summary: "Attach credentials to a connector",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CredentialBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// There is deliberately no end-user-credential endpoint here.
//
// The table, the encryption path and a promotion guard for per-end-user
// credentials all existed, and one route wrote to them — but nothing on the
// execution path ever read a row back. `combine_mode` was stored and never
// consulted. An operator could attach a credential per end user, receive a
// 201, and have it silently never apply.
//
// Accepting data the product cannot honour is worse than not offering the
// feature, so the endpoint is gone. `end_user_credentials` remains in the
// schema for rows written by older versions, and the promotion guard still
// refuses to copy them. Reintroducing this needs a read path in the dispatch
// layer first, not a route.

export function registerCredentialsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(credentialsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");

    const value = credentialBodyToValue(body);

    // If connector auth_type differs, keep them consistent by updating connector too.
    if (connector.auth_type !== body.mode) {
      await connectorSvc.updateConnector(
        principal.tenant_id,
        id,
        { auth_type: body.mode },
        principal.id,
        db,
      );
    }

    const row = await credsvc.upsertCredential(
      {
        tenant_id: principal.tenant_id,
        connector_id: id,
        environment: connector.environment,
        mode: body.mode,
        value,
        actor_id: principal.id,
      },
      db,
    );
    return c.json({ id: row.id }, 201);
  });
}
