import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { computeConnectorScopeDiff } from "../../connectors/oauth-scope-diff.ts";
import { completeConnectorReauthorization } from "../../connectors/reauth.ts";
import { getConnector, updateConnector } from "../../connectors/service.ts";
import { getConnection } from "../../credentials/connections/service.ts";
import type { CredentialPlaintext } from "../../credentials/credential-value.ts";
import { VerifiedProviderIdentitySchema } from "../../credentials/provider-identity.ts";
import { describeCredentialForConnector, upsertCredential } from "../../credentials/service.ts";
import { parseSignedJwtConfig, validateSignedJwtPrivateKey } from "../../credentials/signed-jwt.ts";
import { credentialServesAuthType, type DecryptedCredential } from "../../credentials/types.ts";
import { IdParam } from "../common-schemas.ts";
import { ConnectionSummarySchema } from "../connection-schemas.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";

export const CredentialBody = z
  .object({
    mode: z.enum([
      "none",
      "header",
      "query",
      "bearer",
      "basic",
      "aws_sigv4",
      "signed_jwt",
      "connection",
    ]),
    connection_id: z.string().uuid().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    session_token: z.string().optional(),
    private_key: z
      .string()
      .min(1)
      .max(16384)
      .optional()
      .describe("PKCS#8 PEM private key for signed_jwt. Secret; never returned."),
  })
  .openapi("CredentialBody");

export type StaticCredentialValue = Extract<
  CredentialPlaintext & DecryptedCredential,
  { mode: "none" | "header" | "query" | "bearer" | "basic" | "aws_sigv4" | "signed_jwt" }
>;

export interface CredentialBodyInput {
  mode:
    | "none"
    | "header"
    | "query"
    | "bearer"
    | "basic"
    | "aws_sigv4"
    | "signed_jwt"
    | "connection";
  headers?: Record<string, string> | undefined;
  query?: Record<string, string> | undefined;
  token?: string | undefined;
  private_key?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  access_key_id?: string | undefined;
  secret_access_key?: string | undefined;
  session_token?: string | undefined;
}

export function credentialValueOf(body: CredentialBodyInput): StaticCredentialValue | Rejection {
  switch (body.mode) {
    case "connection":
      return reject.badRequest("connection mode carries no credential value");
    case "none":
      return { mode: "none" };
    case "header":
      if (!body.headers) return reject.badRequest("header mode requires headers");
      return { mode: "header", headers: body.headers };
    case "query":
      if (!body.query) return reject.badRequest("query mode requires query");
      return { mode: "query", query: body.query };
    case "bearer":
      if (!body.token) return reject.badRequest("bearer mode requires token");
      return { mode: "bearer", token: body.token };
    case "signed_jwt":
      if (!body.private_key) return reject.badRequest("signed_jwt requires private_key");
      return { mode: "signed_jwt", private_key: body.private_key };
    case "basic":
      if (!body.username || body.password === undefined) {
        return reject.badRequest("basic mode requires username and password");
      }
      return { mode: "basic", username: body.username, password: body.password };
    case "aws_sigv4":
      if (!body.access_key_id || !body.secret_access_key) {
        return reject.badRequest("aws_sigv4 mode requires access_key_id and secret_access_key");
      }
      return {
        mode: "aws_sigv4",
        access_key_id: body.access_key_id,
        secret_access_key: body.secret_access_key,
        ...(body.session_token ? { session_token: body.session_token } : {}),
      };
  }
}

const CredentialSummary = z
  .object({
    speaks_as: VerifiedProviderIdentitySchema.nullable(),
    mode: z.string(),
    environment: z.enum(["dev", "prod"]),
    connection: ConnectionSummarySchema.nullable(),
    header_names: z.array(z.string()),
    missing_scopes: z.array(z.string()),
    updated_at: z.string(),
  })
  .nullable()
  .openapi("ConnectorCredentialSummary");

type CredentialSummaryBody = z.infer<typeof CredentialSummary>;
type AttachInput = { readonly id: string } & z.infer<typeof CredentialBody>;

export const getConnectorCredentialOperation = defineOperation<
  { readonly id: string },
  CredentialSummaryBody
>({
  id: "connector.credential.get",
  summary:
    "How a connector authenticates — the mode and the connection it uses, never the material",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const connector = await getConnector(scope.tenant_id, id, scope.db);
    if (!connector) return reject.notFound("connector");
    const summary = await describeCredentialForConnector(
      scope.tenant_id,
      id,
      connector.environment,
      scope.db,
    );
    if (!summary || !credentialServesAuthType(connector.auth_type, summary.mode)) return null;
    const diff = await computeConnectorScopeDiff(scope.db, scope.tenant_id, connector);
    return { ...summary, missing_scopes: diff?.partial_grant === true ? diff.missing : [] };
  },
  http: {
    method: "get",
    path: "/v1/connectors/{id}/credential",
    tags: ["connectors"],
    params: IdParam,
    response: CredentialSummary,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (result) => result,
  },
});

export const attachConnectorCredentialsOperation = defineOperation<
  AttachInput,
  { readonly id: string }
>({
  id: "connector.credentials.attach",
  summary: "Attach credentials to a connector",
  permission: "credential:write",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CREDENTIAL_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const actor = actorOf(principal);
    const connector = await getConnector(scope.tenant_id, body.id, scope.db);
    if (!connector) return reject.notFound("connector");

    if (body.mode === "connection") {
      if (!body.connection_id) return reject.badRequest("connection mode requires connection_id");
      const connection = await getConnection(scope.db, scope.tenant_id, body.connection_id);
      if (connector.auth_type !== "oauth2") {
        await updateConnector(scope.tenant_id, body.id, { auth_type: "oauth2" }, actor, scope.db);
      }
      const row = await upsertCredential(
        {
          tenant_id: scope.tenant_id,
          connector_id: body.id,
          environment: connector.environment,
          mode: "oauth2",
          value: { mode: "oauth2", access_token: "", token_type: "Bearer" },
          connection_id: connection.id,
          actor_id: principal.id,
          actor,
          source: "http_route",
        },
        scope.db,
      );
      await completeConnectorReauthorization(scope.db, {
        tenant_id: scope.tenant_id,
        connector_id: body.id,
        actor_id: principal.id,
        actor,
      });
      return { id: row.id };
    }

    const value = credentialValueOf(body);
    if (isRejection(value)) return value;
    if (value.mode === "signed_jwt") {
      try {
        const config = parseSignedJwtConfig(connector.config ?? {});
        await validateSignedJwtPrivateKey(value.private_key, config.algorithm);
      } catch (error) {
        return reject.badRequest(
          error instanceof Error ? error.message : "Invalid signed JWT credential",
        );
      }
    }

    if (connector.auth_type !== body.mode) {
      await updateConnector(scope.tenant_id, body.id, { auth_type: body.mode }, actor, scope.db);
    }

    const row = await upsertCredential(
      {
        tenant_id: scope.tenant_id,
        connector_id: body.id,
        environment: connector.environment,
        mode: body.mode,
        value,
        actor_id: principal.id,
        actor,
        source: "http_route",
      },
      scope.db,
    );
    await completeConnectorReauthorization(scope.db, {
      tenant_id: scope.tenant_id,
      connector_id: body.id,
      actor_id: principal.id,
      actor,
    });
    return { id: row.id };
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/credentials",
    tags: ["connectors"],
    params: IdParam,
    body: CredentialBody,
    response: z.object({ id: z.string() }),
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 404: "Not found" },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      ...(json as z.infer<typeof CredentialBody>),
    }),
    toBody: (result) => result,
  },
});
