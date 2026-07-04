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
import type { ResolvedPrincipal } from "../../auth/types.ts";
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
  // Owner identity captured at `initialize`. The per-session `server` closes
  // over this principal's tenant/permissions, so every later request on this
  // session id MUST come from the same principal — otherwise a leaked session
  // id would let a second valid token execute inside the owner's tenant
  // context (MCP Security Best Practices: sessions MUST NOT be used for
  // authentication; bind the session id to the authorized user).
  owner: string;
}

// Stable key for the principal that owns a session. Ties the session to the
// authenticated identity (tenant + actor + credential), not to the session id
// alone. Two distinct tokens — even for the same user — produce different keys
// so a token swap cannot ride an existing session.
function ownerKey(p: ResolvedPrincipal): string {
  return `${p.tenant_id}:${p.id}:${p.api_key_id ?? p.session_id ?? p.provider}`;
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
      // The session id resolved, but the credential on THIS request must match
      // the principal that opened the session. A valid token belonging to a
      // different tenant/user (or a different credential for the same user)
      // that presents a leaked session id would otherwise execute inside the
      // owner's server instance — a session-hijack / confused-deputy path. Do
      // not disclose that the id exists: answer with the same 404 the
      // stale-session branch returns.
      if (session.owner !== ownerKey(principal)) {
        logger.warn({
          module: "mcp",
          action: "mcp.session.principal_mismatch",
          msg: "mcp session id presented by a different principal — rejecting",
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
          sessions.set(sid, { transport, server, owner: ownerKey(principal) });
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
        // A second standalone GET SSE stream on a session that already has one
        // self-rejects with this 409. The GET pre-empt below (see the handler)
        // replaces the stale stream before the SDK ever reaches this guard, so
        // in the steady state this branch does not fire — but a race can still
        // slip a duplicate GET through. It is recoverable client churn (the
        // client just re-opens its notification channel), not a transport
        // fault, so log at `debug` like the stale-session case rather than
        // spamming `warn` (this error was the bulk of the observed noise).
        const duplicateStandaloneStream =
          err.message === "Conflict: Only one SSE stream is allowed per session";
        if (duplicateStandaloneStream) {
          logger.debug({
            module: "mcp",
            action: "mcp.session.stream_conflict",
            msg: "duplicate standalone SSE stream — client re-opened its notification channel",
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
      session = { transport, server, owner: ownerKey(principal) };
    }

    // Standalone GET SSE stream: the SDK permits exactly ONE per session
    // (the `_GET_stream` mapping) and 409s a second one. A client that
    // re-opens its server→client notification channel after a network blip —
    // before the server observed the old socket close (half-open TCP,
    // load-balancer churn, a `conversation_get` poll landing mid-reconnect) —
    // otherwise gets a Conflict it cannot recover from, and its notification
    // channel stays dead for the rest of the session (this was the bulk of
    // the observed SSE-conflict noise). Pre-empt any stale standalone stream
    // so the new GET REPLACES it (last-writer-wins reconnection — the SDK's
    // own `closeStandaloneSSEStream` contract). This is a no-op when no
    // standalone stream is open. POST responses ride per-request streams keyed
    // by a fresh id and never collide, so this is scoped to GET only; the
    // backgrounded conversation tools return a buffered POST response in ms
    // and never hold a stream open past the turn.
    if (c.req.method === "GET") {
      session.transport.closeStandaloneSSEStream();
    }

    const res = await session.transport.handleRequest(c.req.raw);
    return res;
  });
}
