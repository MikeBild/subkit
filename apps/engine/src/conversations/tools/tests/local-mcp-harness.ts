import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import type { Db } from "../../../db/client.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../../types.ts";
import type { ToolContext, ToolResult } from "../index.ts";

export interface Harness {
  context: ToolContext;
  draft: () => DraftDocument;
}

export function makeHarness(
  db: Db,
  tenant_id: string,
  connector?: ConnectorDraftDocument,
): Harness {
  let draft = {
    workflow: { name: "", steps: [] },
    ...(connector ? { connector } : {}),
  } as DraftDocument;
  const context = {
    db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: identifier only, never asserted on
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db }),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  } as ToolContext;
  return { context, draft: () => draft };
}

export function dataOf(result: ToolResult): Record<string, unknown> {
  return ((result as { data?: unknown }).data ?? {}) as Record<string, unknown>;
}

export function mcpOf(h: Harness): Record<string, unknown> {
  return (h.draft().connector?.config?.mcp ?? {}) as Record<string, unknown>;
}

export const NO_DISCOVERY: DiscoveryResult = {
  source_url: "http://127.0.0.1:3000/openapi.json",
  fetched_at: "2026-11-27T00:00:00.000Z",
  strategy: "openapi-direct",
  spec_version: "openapi-3",
  title: "Local API",
  servers: [],
  auth_schemes: [{ name: "bearerAuth", type: "http", scheme: "bearer", required: true }],
  endpoints: [],
  warnings: [],
};

export const STDIO_DRAFT: ConnectorDraftDocument = {
  name: "Docker MCP",
  slug: "docker-mcp",
  driver: "mcp",
  environment: "dev",
  auth_type: "none",
  config: {
    mcp: {
      transport: "stdio",
      command: "docker",
      args: ["mcp", "gateway", "run"],
      auth: { kind: "none" },
    },
  },
  docs: [],
  latest_probe: null,
  saved_connector_id: null,
};

export const BEARER_DRAFT: ConnectorDraftDocument = {
  name: "Local API",
  slug: "local-api",
  driver: "http",
  environment: "dev",
  auth_type: "bearer",
  base_url: "http://localhost:3000",
  config: {},
  docs: [],
  latest_probe: null,
  saved_connector_id: null,
};
