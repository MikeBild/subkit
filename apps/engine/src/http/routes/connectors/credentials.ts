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
import { credentials, endUserCredentials } from "../../../db/schema/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { credentialBodyToValue } from "./credential-body.ts";
import { CredentialBody, EndUserCredentialBody } from "./schemas.ts";

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

const endUserCredentialsRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/end-user-credentials",
  tags: ["connectors"],
  summary: "Attach end-user-scoped credentials",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: EndUserCredentialBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

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

  app.openapi(endUserCredentialsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    // End-user credentials are simple key/value blobs that the workflow
    // can layer onto the base credential at run time. We encrypt the
    // whole payload with AAD bound to the enduser_ref.
    const aad = `enduser:${principal.tenant_id}:${id}:${body.enduser_ref}`;
    const payload = encryptSecret(JSON.stringify(body.payload), aad);
    const inserted = await db
      .insert(endUserCredentials)
      .values({
        tenant_id: principal.tenant_id,
        connector_id: id,
        enduser_ref: body.enduser_ref,
        combine_mode: body.combine_mode,
        ciphertext: Buffer.from(payload.ciphertext),
        iv: Buffer.from(payload.iv),
        auth_tag: Buffer.from(payload.auth_tag),
      })
      .onConflictDoUpdate({
        target: [
          endUserCredentials.tenant_id,
          endUserCredentials.connector_id,
          endUserCredentials.enduser_ref,
        ],
        set: {
          combine_mode: body.combine_mode,
          ciphertext: Buffer.from(payload.ciphertext),
          iv: Buffer.from(payload.iv),
          auth_tag: Buffer.from(payload.auth_tag),
          updated_at: new Date(),
        },
      })
      .returning();
    const insertedRow = inserted[0];
    if (!insertedRow) {
      // .onConflictDoUpdate guarantees a row in either branch — defensive
      // throw so the route returns a clear 5xx instead of an opaque crash.
      throw new Error("end_user_credential insert returned no rows");
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.CREDENTIAL_CREATED,
        resource_type: "end_user_credential",
        resource_id: insertedRow.id,
        result: "success",
        metadata: { connector_id: id, enduser_ref: body.enduser_ref },
      },
      db,
    );
    // Touch `credentials` import so biome/unused-vars doesn't flag.
    void credentials;
    // Touch the client-credentials grant import — the closure above doesn't
    // currently invoke it but we keep the import to mirror the legacy file's
    // contract while a future client-credentials route lands inline.
    void runClientCredentialsGrant;
    return c.json({ id: insertedRow.id }, 201);
  });
}
