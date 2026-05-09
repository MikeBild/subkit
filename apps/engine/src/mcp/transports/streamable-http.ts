// Streamable HTTP MCP mount for Hono.
//
// Per-session transports are cached in a Map keyed by the
// `mcp-session-id` header. An initialize request (no session id yet) spins
// up a fresh transport + server instance and stores it under the generated
// session id. Subsequent requests route back to the same transport so
// notifications (including `notifications/progress`) land on the right
// stream.
//
// Synchronous request/response (POST /mcp) returns `application/json` with
// a JSON-RPC envelope directly in the body — required for clients whose
// streamable-HTTP adapter cannot deserialize an SSE-framed initialize
// response (e.g. Codex CLI's rmcp adapter). Notifications and progress
// events still stream over SSE on the long-lived GET /mcp channel.
//
// Auth is handled by Hono's `authMiddleware` before this handler runs —
// `requireAuth(c)` will throw a 401 if the principal is absent.

import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireAuth } from "../../http/middleware/auth.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { logger } from "../../logging/logger.ts";
import { createMcpServer } from "../server.ts";

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
}

export function registerMcpHttpRoutes(app: OpenAPIHono<AppEnv>): void {
  const sessions = new Map<string, Session>();

  // Hono doesn't know about non-200 responses from raw handlers, but
  // `/mcp` is not part of the OpenAPI surface so we use the raw
  // `.all(path, handler)` signature.
  app.all("/mcp", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const sessionHeader = c.req.header("mcp-session-id");

    let session: Session | undefined;
    if (sessionHeader) {
      session = sessions.get(sessionHeader);
    }

    if (!session) {
      // Spin up a new stateful transport. Per-session server so handlers
      // close over the current principal.
      const server = createMcpServer({ db, principal, transport: "http" });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, server });
          logger.info({
            module: "mcp",
            action: "mcp.session.init",
            msg: "mcp session initialized",
            session_id: sid,
            transport: "http",
            principal_id: principal.id,
          });
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          logger.info({
            module: "mcp",
            action: "mcp.session.closed",
            msg: "mcp session closed",
            session_id: sid,
          });
        },
      });
      transport.onerror = (err: Error) => {
        logger.warn({
          module: "mcp",
          action: "mcp.transport.error",
          msg: "mcp transport error",
          error: err.message,
        });
      };
      await server.connect(transport);
      session = { transport, server };
    }

    const res = await session.transport.handleRequest(c.req.raw);
    return res;
  });
}
