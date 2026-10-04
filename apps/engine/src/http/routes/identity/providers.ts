import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";

const ProviderEntry = z
  .object({
    protocol: z.enum(["api_key", "oidc"]),
    id: z.string(),
    label: z.string().min(1),
  })
  .strict()
  .openapi("AuthProvider");

const ProvidersResponse = z
  .object({
    providers: z.array(ProviderEntry),
  })
  .strict()
  .openapi("ProvidersResponse");

const LABELS: Record<"api_key" | "oidc", string> = {
  oidc: "SSO",
  api_key: "API key",
};

const route = createRoute({
  method: "get",
  path: "/v1/identity/providers",
  tags: ["MCP authentication"],
  summary: "List configured authentication methods",
  description:
    "Public. Returns the sign-in methods this installation offers, with a generic label per protocol. No issuer, client id, scope or operator wording is included, and the answer does not change when the caller is authenticated.",
  responses: {
    200: {
      description: "Sanitised provider inventory",
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
        label: LABELS[provider.protocol],
      }));

    return c.json({ providers }, 200);
  });
}
