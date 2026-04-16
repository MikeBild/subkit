// stdio entry point.
//
// Launched via `bun run apps/engine/src/mcp/stdio.ts` (or, eventually,
// `subkit mcp` once the P15 CLI wrapper lands). Reads an API key from
// `SUBKIT_API_KEY`, resolves the principal through the api-key provider,
// then boots an MCP server over a `StdioServerTransport`.
//
// For P7 this runs against the in-process engine (same db pool). A
// `SUBKIT_ENGINE_URL` env variable is reserved for P15 when the stdio
// process federates to a remote engine over REST.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb, getDb } from "../../db/client.ts";
import { newTraceId, withContext } from "../../logging/context.ts";
import { logger } from "../../logging/logger.ts";
import { resolveStdioPrincipal } from "../auth.ts";
import { createMcpServer } from "../server.ts";

async function main(): Promise<void> {
  const apiKey = process.env.SUBKIT_API_KEY;
  if (!apiKey) {
    process.stderr.write("SUBKIT_API_KEY is required for stdio mode\n");
    process.exit(2);
  }
  const db = getDb();
  const principal = await resolveStdioPrincipal(db, apiKey);
  if (!principal) {
    process.stderr.write("invalid SUBKIT_API_KEY\n");
    process.exit(2);
  }

  const server = createMcpServer({ db, principal, transport: "stdio" });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info({
    module: "mcp",
    action: "mcp.stdio.ready",
    msg: "mcp stdio transport ready",
    principal_id: principal.id,
    tenant_id: principal.tenant_id,
  });

  // Park — stdio transport keeps the process alive via stdin.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({
      module: "mcp",
      action: "mcp.stdio.shutdown",
      msg: `received ${signal}, closing`,
    });
    try {
      await server.close();
    } catch {
      // ignore
    }
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  await withContext(
    {
      trace_id: newTraceId(),
      tenant_id: "system",
      request_source: "cli",
      actor_id: "mcp-stdio",
    },
    async () => {
      try {
        await main();
      } catch (err) {
        logger.fatal({
          module: "mcp",
          action: "mcp.stdio.boot_failed",
          msg: "mcp stdio failed to boot",
          error: err instanceof Error ? err.message : String(err),
        });
        await closeDb().catch(() => {});
        process.exit(1);
      }
    },
  );
}
