// GET /v1/identity/providers — authenticated, sanitised provider inventory.
//
// Browser login uses the server-rendered chooser and OAuth clients use the
// standard well-known documents. There is therefore no reason to disclose a
// machine-readable installation-specific provider list before authentication.
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { ErrorSchema } from "./schemas.ts";

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

const route = createRoute({
  method: "get",
  path: "/v1/identity/providers",
  tags: ["MCP authentication"],
  summary: "List configured authentication methods",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Sanitised provider inventory",
      content: { "application/json": { schema: ProvidersResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerProvidersRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/providers", requirePermission("identity:read"));
  app.openapi(route, async (c) => {
    const { getConfig } = await import("../../../config/loader.ts");
    const providers: z.infer<typeof ProviderEntry>[] = [...getConfig().auth.providers]
      .sort(
        (left, right) => Number(left.protocol === "api_key") - Number(right.protocol === "api_key"),
      )
      .map((provider) => ({
        protocol: provider.protocol,
        id: provider.id,
        label: provider.label,
      }));

    return c.json({ providers }, 200);
  });
}
