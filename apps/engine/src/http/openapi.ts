import type { IncomingMessage } from "node:http";
import { VERSION } from "@cli-core/version.ts";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { RequestSource, ServiceMetadata } from "../observability/service-metadata.ts";
import { type JsonObject, refineOpenApiDocument } from "./openapi-document.ts";

export type AppEnv = {
  Bindings: { incoming?: IncomingMessage };
  Variables: {
    client_ip?: string;
    hosted_ingress_admitted?: boolean;
    trace_id: string;
    span_id: string;
    request_source: RequestSource;
    request_started_at: number;
    db: Db;
    boss?: PgBoss;
    principal?: ResolvedPrincipal;
    workflow_permission?: import("../execution/index.ts").WorkflowPermission | null;
    service_metadata?: ServiceMetadata;
  };
};

export function createOpenApiApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            code: "bad_request",
            message: "request validation failed",
            details: result.error.flatten(),
          },
          400,
        );
      }
      return undefined;
    },
  });
  const generate = app.getOpenAPI31Document;
  app.getOpenAPI31Document = (objectConfig, generatorConfig) => {
    const generated: JsonObject = JSON.parse(
      JSON.stringify(generate(objectConfig, generatorConfig)),
    );
    return JSON.parse(JSON.stringify(refineOpenApiDocument(generated)));
  };
  return app;
}

function resolveEngineVersion(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = process.env.ENGINE_VERSION;
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

export const OPENAPI_INFO = {
  title: "subkit engine",
  version: resolveEngineVersion(),
  description:
    "Backend workflow engine. See /docs for the interactive reference and /openapi.json for the raw spec. LLM clients can ground themselves on /llms.txt (index) or /llms-full.txt (full docs in one fetch), per https://llmstxt.org, and on /docs.json (every chapter in English and German as one JSON bundle).",
} as const;

export const SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http" as const,
    scheme: "bearer" as const,
    description:
      "SubKit API key or an OAuth 2.1 access token issued by the MCP authorization server. A credential that carries a scope list is bounded by it: GET /metrics requires the metrics:read scope from API keys, RFC 8693 exchanged tokens and connection tokens alike, and the caller's role does not widen it.",
  },
  oauth2: {
    type: "oauth2" as const,
    description:
      "OAuth 2.1 authorization-code flow with PKCE. Browser login uses product-local API-key or direct OIDC adapters.",
    flows: {
      authorizationCode: {
        authorizationUrl: "/v1/oauth/authorize",
        tokenUrl: "/v1/oauth/token",
        scopes: {
          "mcp:read": "Read published content, resources, and product statistics",
          "mcp:authoring": "Create drafts, revisions, and previews",
          "mcp:admin": "Publish releases and administer access",
          "metrics:read": "Read the operational counters exposed by GET /metrics — nothing else",
        },
      },
    },
  },
  browserSession: {
    type: "apiKey" as const,
    in: "cookie" as const,
    name: "subkit_session",
    description: "HttpOnly same-origin browser session used by the SubKit Cockpit.",
  },
};
