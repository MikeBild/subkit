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

    const { getConfig } = await import("../../../config/loader.ts");
    const auth = getConfig().auth;

    // The human identity provider is selected by `auth.provider`; exactly one
    // external provider is advertised (or none, for "subkit"). Firebase —
    // advertised only when selected and a project_id is configured.
    const firebaseProjectId = auth.firebase.project_id;
    const firebaseLoginUrl = auth.firebase.login_url;
    if (auth.provider === "firebase" && firebaseProjectId) {
      providers.push({
        type: "firebase",
        name: "Google (via Firebase)",
        login_url: firebaseLoginUrl || `https://${firebaseProjectId}.web.app`,
        issuer: `https://securetoken.google.com/${firebaseProjectId}`,
      });
    }

    // Generic OIDC — advertised only when selected and an issuer is set.
    const oidcIssuer = auth.oidc.issuer_url;
    if (auth.provider === "oidc" && oidcIssuer) {
      providers.push({
        type: "oidc",
        name: "OIDC (device flow)",
        issuer: oidcIssuer,
      });
    }

    // API key — machine auth is always available; advertised as the local
    // surface (and the only human path under the default "subkit" provider,
    // where keys are provisioned via admin-invite).
    providers.push({
      type: "api-key",
      name: "API key",
    });

    return c.json({ providers }, 200);
  });
}
