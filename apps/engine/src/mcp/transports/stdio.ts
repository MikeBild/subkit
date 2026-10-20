import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { closeDb, getDb } from "../../db/client.ts";
import { newTraceId, withContext, withIsolatedContext } from "../../logging/context.ts";
import { logger } from "../../logging/logger.ts";
import { resolveStdioPrincipal } from "../auth.ts";
import { createMcpServer } from "../server.ts";

export function bindStdioPrincipalContext(
  transport: StdioServerTransport,
  principal: ResolvedPrincipal,
): void {
  const dispatch = transport.onmessage;
  if (!dispatch) throw new Error("stdio MCP transport has no message handler");
  const authSource = principal.auth_source;
  const apiKeyId =
    authSource?.kind === "api_key" || authSource?.kind === "token_exchange"
      ? authSource.api_key_id
      : undefined;
  transport.onmessage = (message) =>
    withIsolatedContext(
      {
        trace_id: newTraceId(),
        audit_trace_id: crypto.randomUUID().replace(/-/g, ""),
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        request_source: "cli",
        audit_origin_source: "mcp",
        audit_execution_source: "mcp",
        ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
        ...(authSource ? { audit_access_type: authSource.kind } : {}),
        ...(apiKeyId && principal.oauth_client_id
          ? { audit_oauth_client_id: principal.oauth_client_id }
          : {}),
        ...(apiKeyId && principal.credential_origin
          ? { audit_credential_origin: principal.credential_origin }
          : {}),
        ...(principal.via ? { auth_via: principal.via } : {}),
      },
      () => dispatch(message),
    );
}

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

  const server = await createMcpServer({ db, principal, transport: "stdio" });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  bindStdioPrincipalContext(transport, principal);

  logger.info({
    module: "mcp",
    action: "mcp.stdio.ready",
    msg: "mcp stdio transport ready",
    principal_id: principal.id,
    tenant_id: principal.tenant_id,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({
      module: "mcp",
      action: "mcp.stdio.shutdown",
      msg: `received ${signal}, closing`,
    });
    try {
      await server.close();
    } catch {}
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
      audit_origin_source: "mcp",
      audit_execution_source: "mcp",
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
