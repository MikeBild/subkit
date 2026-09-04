// Shared OpenAPIHono instance and document metadata. Routes import this
// file to register themselves on a single document.

import { VERSION } from "@cli-core/version.ts";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { RequestSource, ServiceMetadata } from "../observability/service-metadata.ts";

export type AppEnv = {
  Variables: {
    trace_id: string;
    /** W3C server span id created for this request. */
    span_id: string;
    /** Canonical request-source label. The trace middleware sets this
     *  for every request (api / mcp / webhook / chat by default); the
     *  type widens to the full canonical enum so non-HTTP entry points
     *  (CLI direct invocation, scheduler ticks) that share the same
     *  context shape stay assignable. Single source of truth lives at
     *  `observability/service-metadata.ts:RequestSourceSchema`. */
    request_source: RequestSource;
    request_started_at: number;
    db: Db;
    /** Request-local queue runtime. Tests bind an isolated PgBoss instance;
     * production falls back to the process-wide engine singleton. */
    boss?: PgBoss;
    principal?: ResolvedPrincipal;
    /**
     * Bound by the auth middleware once a principal resolves. Downstream
     * handlers use `c.get("service_metadata")` to thread a single
     * identity envelope through audit, telemetry, execution, and
     * notification dispatch instead of pulling fields ad-hoc.
     * Absent for unauthenticated routes (health probe, login).
     */
    service_metadata?: ServiceMetadata;
  };
};

export function createOpenApiApp(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
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
}

// Compile-time `VERSION` wins over runtime `ENGINE_VERSION` when the
// build actually stamped a real version (anything other than the
// `0.0.0-dev` placeholder). Pre-fix `process.env.ENGINE_VERSION` came
// first, so a default `compose up` without an explicit `ENGINE_VERSION`
// in the operator's shell injected `0.0.0-dev` and overrode the baked-
// in value — the CLI's version-skew banner then fired against an
// engine the operator had just rebuilt with the right version.
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
    "Backend workflow engine. See /docs for the interactive reference and /openapi.json for the raw spec. LLM clients can ground themselves on /llms.txt (index) or /llms-full.txt (full docs in one fetch), per https://llmstxt.org.",
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
