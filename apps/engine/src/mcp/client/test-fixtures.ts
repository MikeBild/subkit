import { createConnector } from "../../connectors/service.ts";
import type { Executor } from "../../db/client.ts";
import type { McpAuthConfig } from "./registry.ts";

export interface SeedMcpConnectorInput {
  tenant_id: string;
  slug: string;
  url: string;
  transport?: "http" | "sse";
  auth?: McpAuthConfig;
  auth_type?:
    | "none"
    | "bearer"
    | "basic"
    | "header"
    | "oauth2"
    | "oauth2_client"
    | "oauth2_private_key";
  display_name?: string;
  environment?: "dev" | "prod";
  remote_tool_call_timeout_ms?: number;
}

export async function seedMcpConnector(
  db: Executor,
  input: SeedMcpConnectorInput,
): Promise<{ id: string; slug: string; url: string }> {
  const authType =
    input.auth_type ??
    (
      {
        none: "none",
        bearer: "bearer",
        basic: "basic",
        header: "header",
        oauth2: "oauth2",
        oauth2_client_credentials: "oauth2_client",
        oauth2_private_key_jwt: "oauth2_private_key",
      } satisfies Record<McpAuthConfig["kind"], NonNullable<SeedMcpConnectorInput["auth_type"]>>
    )[input.auth?.kind ?? "none"];
  const view = await createConnector(
    {
      tenant_id: input.tenant_id,
      actor_id: null,
      input: {
        name: input.display_name ?? input.slug,
        slug: input.slug,
        driver: "mcp",
        environment: input.environment ?? "prod",
        auth_type: authType,
        base_url: input.url,
        config: {
          mcp: {
            transport: input.transport ?? "http",
            ...(input.auth ? { auth: input.auth } : {}),
            ...(input.remote_tool_call_timeout_ms !== undefined
              ? { remote_tool_call_timeout_ms: input.remote_tool_call_timeout_ms }
              : {}),
          },
        },
      },
    },
    db,
  );
  return { id: view.id, slug: view.slug, url: input.url };
}
