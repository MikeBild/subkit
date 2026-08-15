// Seeding an external MCP server for a test.
//
// An external MCP server is a connector whose driver is `mcp`, and there is
// no registry write path any more — an operator creates one through
// `POST /v1/connectors` like every other driver. A test that wants a server
// therefore needs a connector row, and hand-writing the `config.mcp` block
// at a dozen call sites is how the block and the schema drift apart.
//
// This helper writes the row through `createConnector`, so a fixture that
// would be rejected by `McpConnectorConfigSchema` fails in the test that
// seeds it rather than in the handshake that reads it.
//
// TEST-ONLY. Not exported from the subsystem barrel: production code never
// creates a connector through anything but the connector service.

import { createConnector } from "../../connectors/service.ts";
import type { Executor } from "../../db/client.ts";
import type { McpAuthConfig } from "./registry.ts";

export interface SeedMcpConnectorInput {
  tenant_id: string;
  /** Namespaces the remote's tools as `mcp_<slug>__<tool>`. */
  slug: string;
  url: string;
  transport?: "http" | "sse";
  auth?: McpAuthConfig;
  /** Declared auth mode. Must match the mode of whatever credential the
   *  test seeds, exactly as it must on a real connector. */
  auth_type?: "none" | "bearer" | "basic" | "oauth2" | "oauth2_client" | "oauth2_private_key";
  display_name?: string;
  /** Defaults to `prod` — the environment `MCP_CREDENTIAL_ENVIRONMENT`
   *  pins, so a credential seeded for the same connector is findable. */
  environment?: "dev" | "prod";
  /** Per-connector call bound. Present so a test can seed the lever that
   *  exists INSTEAD of progress-extended deadlines, rather than asserting
   *  the lever from prose. */
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
