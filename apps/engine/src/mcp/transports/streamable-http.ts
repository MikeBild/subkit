// Streamable HTTP MCP mount for Hono.
//
// Per-session transports are cached in a Map keyed by the
// `mcp-session-id` header. An initialize request (no session id yet) spins
// up a fresh transport + server instance and stores it under the generated
// session id. Subsequent requests route back to the same transport so
// notifications (including `notifications/progress`) land on the right
// stream.
//
// `enableJsonResponse` is OFF. Every POST /mcp — including `tools/call`
// — opens an SSE stream for its response. This is REQUIRED for MCP
// elicitation: a tool whose `execute` issues a server→client
// `elicitation/create` request mid-call can only deliver that request
// (and receive the client's reply) when the originating POST holds an
// open SSE stream. Under `enableJsonResponse: true` the transport
// buffers a single JSON envelope and closes the stream before the
// nested request can be flushed — `server.elicitInput()` then hangs
// until its timeout. The trade-off (an SSE frame for the initialize
// response) is acceptable; modern MCP clients all deserialize
// SSE-framed responses. The stdio transport is unaffected and unchanged.
//
// Auth is handled by Hono's `authMiddleware` before this handler runs —
// `requireAuth(c)` will throw a 401 if the principal is absent.

import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getConfig } from "../../config/loader.ts";
import { UnauthorizedError } from "../../http/errors.ts";
import { requireAuth } from "../../http/middleware/auth.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { logger } from "../../logging/logger.ts";
import { createMcpServer } from "../server.ts";
import { validateMcpStreamableHttpRequest } from "./guards.ts";

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
    // When no principal resolved, emit the RFC 9728 resource_metadata discovery
    // header so OAuth-only clients (ChatGPT, Claude.ai, Cursor) can perform
    // the authorization server discovery handshake.
    const guarded = validateMcpStreamableHttpRequest(c.req.raw);
    if (!guarded.ok) {
      logger.debug({
        module: "mcp",
        action: `mcp.transport.${guarded.reason}`,
        msg: "mcp streamable-http request rejected by transport guard",
      });
      return guarded.response;
    }

    if (!c.get("principal")) {
      let baseUrl = "";
      try {
        baseUrl = getConfig().server.public_base_url;
      } catch {
        /* config not loaded yet — degrade gracefully */
      }
      const wwwAuth = baseUrl
        ? `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:read"`
        : 'Bearer scope="mcp:read"';
      throw new UnauthorizedError("missing_or_invalid_credentials", wwwAuth);
    }
    const principal = requireAuth(c);
    const db = c.get("db");
    const sessionHeader = c.req.header("mcp-session-id");

    let session: Session | undefined;
    if (sessionHeader) {
      session = sessions.get(sessionHeader);
      if (!session) {
        // The client holds a session id this process no longer has — an
        // engine restart dropped the in-memory map, or we already closed
        // the session. Per the MCP Streamable HTTP spec the server SHOULD
        // answer 404 so the client re-runs the `initialize` handshake.
        // This is routine client churn, not a transport fault: log at
        // `debug` and return the 404 directly. Falling through to build a
        // fresh transport would make that transport self-reject with
        // "Server not initialized" (it never saw the handshake) — the noise
        // this branch exists to eliminate.
        logger.debug({
          module: "mcp",
          action: "mcp.session.stale",
          msg: "unknown mcp session id — client should re-initialize",
          session_id: sessionHeader,
          principal_id: principal.id,
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
    }

    if (!session) {
      // Spin up a new stateful transport. Per-session server so handlers
      // close over the current principal.
      const server = await createMcpServer({ db, principal, transport: "http" });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // OFF — see the header note: mid-tool-call `elicitation/create`
        // requests require the POST to keep an SSE stream open.
        enableJsonResponse: false,
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
        // A non-initialize request that reached this fresh transport with no
        // session id at all self-rejects with "Server not initialized" — the
        // client skipped the handshake. That's recoverable client churn, not
        // a fault; log it at `debug` like the stale-session case above. Every
        // other transport error stays at `warn`.
        const staleSession = err.message === "Bad Request: Server not initialized";
        if (staleSession) {
          logger.debug({
            module: "mcp",
            action: "mcp.session.stale",
            msg: "mcp request before initialize — client should re-initialize",
            error: err.message,
            principal_id: principal.id,
          });
          return;
        }
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
