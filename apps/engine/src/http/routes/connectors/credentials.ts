import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { ConnectionSummarySchema } from "../../../api/connection-schemas.ts";
import { actorOf } from "../../../audit/index.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import * as credsvc from "../../../credentials/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
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

const CredentialSummary = z
  .object({
    speaks_as: credsvc.VerifiedProviderIdentitySchema.nullable(),
    mode: z.string(),
    environment: z.enum(["dev", "prod"]),
    connection: ConnectionSummarySchema.nullable(),
    header_names: z.array(z.string()),
    missing_scopes: z.array(z.string()),
    updated_at: z.string(),
  })
  .nullable()
  .openapi("ConnectorCredentialSummary");

const credentialSummaryRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/credential",
  tags: ["connectors"],
  summary:
    "How a connector authenticates — the mode and the connection it uses, never the material",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: CredentialSummary } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCredentialsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(credentialSummaryRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const summary = await credsvc.describeCredentialForConnector(
      principal.tenant_id,
      id,
      connector.environment,
      db,
    );
    if (!summary || !credsvc.credentialServesAuthType(connector.auth_type, summary.mode))
      return c.json(null, 200);
    const diff = await connectorSvc.computeConnectorScopeDiff(db, principal.tenant_id, connector);
    return c.json(
      { ...summary, missing_scopes: diff?.partial_grant === true ? diff.missing : [] },
      200,
    );
  });

  app.openapi(credentialsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");

    if (body.mode === "connection") {
      if (!body.connection_id) throw new BadRequestError("connection mode requires connection_id");
      const connection = await credsvc.getConnection(db, principal.tenant_id, body.connection_id);
      if (connector.auth_type !== "oauth2") {
        await connectorSvc.updateConnector(
          principal.tenant_id,
          id,
          { auth_type: "oauth2" },
          actorOf(principal),
          db,
        );
      }
      const row = await credsvc.upsertCredential(
        {
          tenant_id: principal.tenant_id,
          connector_id: id,
          environment: connector.environment,
          mode: "oauth2",
          value: { mode: "oauth2", access_token: "", token_type: "Bearer" },
          connection_id: connection.id,
          actor_id: principal.id,
          actor: actorOf(principal),
          source: "http_route",
        },
        db,
      );
      await connectorSvc.completeConnectorReauthorization(db, {
        tenant_id: principal.tenant_id,
        connector_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
      });
      return c.json({ id: row.id }, 201);
    }

    const value = credentialBodyToValue(body);
    if (value.mode === "signed_jwt") {
      try {
        const config = credsvc.parseSignedJwtConfig(connector.config ?? {});
        await credsvc.validateSignedJwtPrivateKey(value.private_key, config.algorithm);
      } catch (error) {
        throw new BadRequestError(
          error instanceof Error ? error.message : "Invalid signed JWT credential",
        );
      }
    }

    if (connector.auth_type !== body.mode) {
      await connectorSvc.updateConnector(
        principal.tenant_id,
        id,
        { auth_type: body.mode },
        actorOf(principal),
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
        actor: actorOf(principal),
        source: "http_route",
      },
      db,
    );
    await connectorSvc.completeConnectorReauthorization(db, {
      tenant_id: principal.tenant_id,
      connector_id: id,
      actor_id: principal.id,
      actor: actorOf(principal),
    });
    return c.json({ id: row.id }, 201);
  });
}
