// GET /v1/identity/providers — public endpoint for auth provider discovery.
//
// CLIs call this to find out which auth methods are available before
// prompting the user. Returns a list of configured providers with
// enough metadata for the CLI to open the right login flow.
//
// This route is intentionally public (no requireAuth) — the caller
// has no API key yet.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";

const ProviderEntry = z
  .object({
    type: z.string(),
    name: z.string(),
    login_url: z.string().url().optional(),
    issuer: z.string().url().optional(),
  })
  .openapi("AuthProvider");

const ProvidersResponse = z
  .object({
    providers: z.array(ProviderEntry),
  })
  .openapi("ProvidersResponse");

const route = createRoute({
  method: "get",
  path: "/v1/identity/providers",
  tags: ["identity"],
  summary: "List available authentication providers",
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ProvidersResponse } },
    },
  },
});

export function registerProvidersRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const providers: z.infer<typeof ProviderEntry>[] = [];

    // Firebase Auth — detected via FIREBASE_PROJECT_ID env var
    const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
    const firebaseLoginUrl = process.env.FIREBASE_LOGIN_URL;
    if (firebaseProjectId) {
      providers.push({
        type: "firebase",
        name: "Google (via Firebase)",
        login_url: firebaseLoginUrl ?? `https://${firebaseProjectId}.web.app`,
        issuer: `https://securetoken.google.com/${firebaseProjectId}`,
      });
    }

    // Generic OIDC — detected via OIDC_ISSUER_URL env var
    const oidcIssuer = process.env.OIDC_ISSUER_URL;
    if (oidcIssuer) {
      providers.push({
        type: "oidc",
        name: "OIDC (device flow)",
        issuer: oidcIssuer,
      });
    }

    // API key is always available as a fallback
    providers.push({
      type: "api-key",
      name: "API key",
    });

    return c.json({ providers }, 200);
  });
}
