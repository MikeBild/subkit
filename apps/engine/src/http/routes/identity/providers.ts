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
    protocol: z.enum(["api_key", "token_bridge", "oidc"]),
    id: z.string(),
    label: z.string(),
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
    const { getConfig } = await import("../../../config/loader.ts");
    const providers: z.infer<typeof ProviderEntry>[] = getConfig().auth.providers.map(
      (provider) => {
        if (provider.protocol === "api_key") {
          return { protocol: provider.protocol, id: provider.id, label: provider.label };
        }
        if (provider.protocol === "token_bridge") {
          return {
            protocol: provider.protocol,
            id: provider.id,
            label: provider.label,
            login_url: provider.login_url,
            issuer: provider.issuer_url,
          };
        }
        return {
          protocol: provider.protocol,
          id: provider.id,
          label: provider.label,
          issuer: provider.issuer_url,
        };
      },
    );

    return c.json({ providers }, 200);
  });
}
