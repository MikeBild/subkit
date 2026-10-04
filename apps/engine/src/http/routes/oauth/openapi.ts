import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";

type RegistryRoute = Parameters<OpenAPIHono<AppEnv>["openAPIRegistry"]["registerPath"]>[0];

const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
const html = { "text/html": { schema: { type: "string" as const } } };
const form = {
  required: true,
  content: {
    "application/x-www-form-urlencoded": {
      schema: { type: "object" as const, additionalProperties: { type: "string" as const } },
    },
  },
};
const errors = {
  400: { description: "Invalid request", content: json({ type: "object" }) },
  401: { description: "Identity assertion rejected", content: json({ type: "object" }) },
  403: { description: "Identity or requested access denied", content: json({ type: "object" }) },
};

function register(
  app: OpenAPIHono<AppEnv>,
  method: "get" | "post",
  path: string,
  operationId: string,
  summary: string,
  responses: RegistryRoute["responses"],
  request?: RegistryRoute["request"],
): void {
  app.openAPIRegistry.registerPath({
    method,
    path,
    operationId,
    tags: ["MCP authentication"],
    summary,
    ...(request ? { request } : {}),
    responses,
  });
}

export function registerRawMcpAuthOpenApi(app: OpenAPIHono<AppEnv>): void {
  const metadata = { 200: { description: "Metadata", content: json({ type: "object" }) } };
  register(
    app,
    "get",
    "/.well-known/oauth-protected-resource",
    "getOAuthProtectedResource",
    "Read MCP protected-resource metadata",
    metadata,
  );
  register(
    app,
    "get",
    "/.well-known/oauth-protected-resource/mcp",
    "getMcpOAuthProtectedResource",
    "Read MCP protected-resource metadata",
    metadata,
  );
  register(
    app,
    "get",
    "/.well-known/oauth-protected-resource/v1/identity/cli-session",
    "getCliLoginOAuthProtectedResource",
    "Read CLI-login protected-resource metadata",
    metadata,
  );
  register(
    app,
    "get",
    "/.well-known/oauth-authorization-server",
    "getOAuthAuthorizationServer",
    "Read OAuth authorization-server metadata",
    metadata,
  );
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/oauth/register",
    operationId: "registerOAuthClient",
    tags: ["MCP authentication"],
    summary: "Register a public OAuth client",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["redirect_uris"],
              properties: {
                redirect_uris: { type: "array", items: { type: "string", format: "uri" } },
                client_name: { type: "string" },
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: "Client registered", content: json({ type: "object" }) },
      ...errors,
    },
  });
  register(
    app,
    "get",
    "/v1/oauth/authorize",
    "authorizeOAuthClient",
    "Start authorization-code login and consent",
    {
      200: { description: "Login or consent HTML", content: html },
      302: { description: "Redirect" },
      ...errors,
    },
  );
  register(
    app,
    "post",
    "/v1/oauth/authorize/decision",
    "decideOAuthConsent",
    "Approve or deny consent",
    { 302: { description: "OAuth redirect" }, ...errors },
    { body: form },
  );
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/oauth/token",
    operationId: "exchangeOAuthToken",
    tags: ["MCP authentication"],
    summary: "Exchange an authorization code, a refresh token, or an API key for tokens",
    description:
      "Form-encoded OAuth 2.1 token endpoint. `grant_type=authorization_code` and " +
      "`grant_type=refresh_token` serve MCP clients. " +
      "`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693) turns an " +
      "API key into a short-lived Bearer token: send " +
      "`subject_token=<api key>` and " +
      "`subject_token_type=urn:subkit:params:oauth:token-type:api-key`; no client_id or " +
      "client secret. Optional `scope` narrows to a subset of the key's scopes " +
      "(`workflow:<id>` entries narrow the workflows) — anything wider is refused with " +
      "`invalid_scope`. Optional `ttl` (seconds) is capped at 3600; default 900. The " +
      "response carries `access_token`, `token_type=Bearer`, " +
      "`issued_token_type=urn:ietf:params:oauth:token-type:access_token`, `expires_in` " +
      "and `scope`, and no refresh token. The token is accepted everywhere the key is " +
      "(same principal, tenant, roles and allow-lists; audit rows carry " +
      "`via: token_exchange`). Revoking, expiring or rotating the key refuses its tokens " +
      "at once. A revoked or unknown key answers 401 `invalid_grant`.",
    request: { body: form },
    responses: {
      200: {
        description: "Tokens",
        content: json({
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string", enum: ["Bearer"] },
            issued_token_type: { type: "string" },
            expires_in: { type: "integer" },
            scope: { type: "string" },
            refresh_token: { type: "string" },
          },
        }),
      },
      ...errors,
    },
  });
  register(
    app,
    "post",
    "/v1/oauth/revoke",
    "revokeOAuthToken",
    "Revoke an OAuth token family",
    {
      200: {
        description: "Revoked; a refresh token invalidates its family and associated access tokens",
      },
      ...errors,
    },
    { body: form },
  );
  register(
    app,
    "get",
    "/v1/identity/login/start",
    "startIdentityLogin",
    "Show the SSO-first login chooser or start a selected method",
    {
      200: { description: "Login HTML", content: html },
      302: { description: "Provider redirect" },
      ...errors,
    },
  );
  register(
    app,
    "post",
    "/v1/identity/login/start",
    "submitApiKeyLogin",
    "Authenticate the API-key login method",
    { 200: { description: "Consent HTML", content: html }, ...errors },
    { body: form },
  );
  register(
    app,
    "get",
    "/v1/identity/login/callback",
    "completeOidcLogin",
    "Complete an OIDC login adapter",
    {
      200: { description: "Consent HTML", content: html },
      302: { description: "Redirect" },
      ...errors,
    },
  );
  register(
    app,
    "post",
    "/v1/identity/logout",
    "logoutIdentitySession",
    "Revoke the browser operator session",
    { 200: { description: "Logged out" }, 204: { description: "Completed" } },
  );
}
