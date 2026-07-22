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

/** Document raw Hono routes without registering a second runtime handler. */
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
  register(
    app,
    "post",
    "/v1/oauth/token",
    "exchangeOAuthToken",
    "Exchange or refresh OAuth tokens",
    { 200: { description: "Tokens", content: json({ type: "object" }) }, ...errors },
    { body: form },
  );
  register(
    app,
    "post",
    "/v1/oauth/revoke",
    "revokeOAuthToken",
    "Revoke an OAuth token family",
    { 200: { description: "Revoked" }, ...errors },
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
