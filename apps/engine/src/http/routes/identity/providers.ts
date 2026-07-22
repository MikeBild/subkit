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
    protocol: z.enum(["api_key", "oidc"]),
    id: z.string(),
    label: z.enum(["SSO", "API key"]),
    issuer: z.string().url().optional(),
  })
  .strict()
  .openapi("AuthProvider");

const ProvidersResponse = z
  .object({
    providers: z.array(ProviderEntry),
  })
  .strict()
  .openapi("ProvidersResponse");

const route = createRoute({
  method: "get",
  path: "/v1/identity/providers",
  tags: ["MCP authentication"],
  summary: "List available MCP authentication methods",
  responses: {
    200: {
      description: "Canonical SSO-first method matrix",
      content: { "application/json": { schema: ProvidersResponse } },
    },
  },
});

export function registerProvidersRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const { getConfig } = await import("../../../config/loader.ts");
    const providers: z.infer<typeof ProviderEntry>[] = [...getConfig().auth.providers]
      .sort(
        (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
      )
      .map((provider) => ({
        protocol: provider.protocol,
        id: provider.id,
        label: provider.protocol === "api_key" ? "API key" : "SSO",
        ...(provider.protocol === "oidc" ? { issuer: provider.issuer_url } : {}),
      }));

    return c.json({ providers }, 200);
  });
}
