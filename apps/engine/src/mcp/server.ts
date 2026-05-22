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
import { ConversationTaskStore } from "./tasks/task-store.ts";

export interface CreateMcpServerParams {
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

export function createMcpServer(p: CreateMcpServerParams): Server {
  const { db, principal, transport } = p;

  // Per-session, tenant-bound TaskStore backing the MCP async-Tasks
  // surface (SEP-1686). Every conversation tool can be invoked as a
  // task so the `tools/call` returns immediately and the long turn
  // runs in the `conversation.run-turn` pg-boss worker.
  const taskStore = new ConversationTaskStore({ db, tenant_id: principal.tenant_id });

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
        // Tasks: list + cancel + task-augmented `tools/call`. The SDK
        // installs the tasks/get|result|list|cancel handlers when a
        // `taskStore` is supplied; this capability advertises them to
        // the client during initialize.
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
      taskStore,
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
