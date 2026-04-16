// MCP server factory.
//
// Builds a fresh `Server` instance per transport session. Each connection
// owns its own server because the request handlers close over the caller's
// principal — this keeps tenant isolation local and avoids a shared
// principal cache.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
import { registerCompletionCapability } from "./capabilities/completion.ts";
import { registerPromptsCapability } from "./capabilities/prompts.ts";
import { registerResourcesCapability } from "./capabilities/resources.ts";
import { registerToolsCapability } from "./capabilities/tools.ts";

export interface CreateMcpServerParams {
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function createMcpServer(p: CreateMcpServerParams): Server {
  const { db, principal, transport } = p;

  const server = new Server(
    {
      name: "subkit-engine",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        prompts: {},
      },
    },
  );

  registerToolsCapability({ server, db, principal, transport });
  registerResourcesCapability({ server, db, principal });
  registerPromptsCapability({ server, db, principal });
  registerCompletionCapability({ server, db, principal });

  logger.info({
    module: "mcp",
    action: "mcp.connected",
    msg: "mcp server assembled",
    transport,
    principal_id: principal.id,
    tenant_id: principal.tenant_id,
  });

  return server;
}
