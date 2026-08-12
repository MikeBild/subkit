// Streamable HTTP MCP mount for Hono.
//
// Per-session transports are cached in a Map keyed by the
// `mcp-session-id` header. An initialize request (no session id yet) spins
// up a fresh transport + server instance and stores it under the generated
// session id. Subsequent requests route back to the same transport so
// notifications (including `notifications/progress`) land on the right
// stream.
//
// A map entry is a LEASE, not a permanent allocation: it survives while
// requests keep touching it or work is in flight on it, and an idle sweeper
// reclaims the rest (see `SESSION_IDLE_TTL_MS`). Clients that drop off without
// the spec's `DELETE` would otherwise pin their server + transport — and the
// `globalEmitter` listeners its capability modules registered — for the life of
// the process.
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
import {
  recordUsageEvent,
  type TrafficClass,
  trafficClassFromHeader,
} from "../../stats/usage-events.ts";
import { now } from "../../utils/clock.ts";
import { createMcpServer } from "../server.ts";
import { validateMcpStreamableHttpRequest } from "./guards.ts";
import { classifyMcpRequest, mcpOutcome } from "./request-labels.ts";
import {
  createSessionLeaseManager,
  MAX_LIVE_SESSIONS_HARD,
  ownerKey,
  type Session,
  STREAM_RETAIN_SILENT_MS,
  trackStreamLifetime,
} from "./session-lease.ts";

function trackMcpUsageStream(
  body: ReadableStream<Uint8Array>,
  onEnd: (outcome: "completed" | "cancelled" | "errored", bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let ended = false;
  const finish = (outcome: "completed" | "cancelled" | "errored") => {
    if (ended) return;
    ended = true;
    onEnd(outcome, bytes);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish("completed");
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (err) {
        finish("errored");
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish("cancelled");
      await reader.cancel(reason);
    },
  });
}

// Only SSE bodies outlive `handleRequest`. Buffered JSON errors and 202s are
// complete the moment they are returned, so they must not pin a lease.
function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

export function registerMcpHttpRoutes(app: OpenAPIHono<AppEnv>): void {
  const { sessions, startSweeper, stopSweeper, evictOverflow, hasAdmissionRoom, retain, release } =
    createSessionLeaseManager();

  // Hono doesn't know about non-200 responses from raw handlers, but
  // `/mcp` is not part of the OpenAPI surface so we use the raw
  // `.all(path, handler)` signature.
  app.all("/mcp", async (c) => {
    const requestStartedAt = now();
    const requestClassPromise = classifyMcpRequest(c.req.raw);
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
      // Advertise the FULL supported scope set (same source as the RFC 8414
      // discovery document) — clients derive their authorization request from
      // this challenge, and a read-only scope here would hide the authoring
      // and admin checkboxes from the consent screen.
      let scopes = "mcp:read";
      try {
        const config = getConfig();
        baseUrl = config.server.public_base_url;
        if (config.auth.mcp_oauth.scopes_supported.length > 0) {
          scopes = config.auth.mcp_oauth.scopes_supported.join(" ");
        }
      } catch {
        /* config not loaded yet — degrade gracefully */
      }
      const wwwAuth = baseUrl
        ? `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${scopes}"`
        : `Bearer scope="${scopes}"`;
      throw new UnauthorizedError("missing_or_invalid_credentials", wwwAuth);
    }
    const principal = requireAuth(c);
    const db = c.get("db");
    const sessionHeader = c.req.header("mcp-session-id");
    const trafficClass = trafficClassFromHeader(c.req.header("x-subkit-traffic-class"));
    const requestClass = await requestClassPromise;

    const recordRequest = (args: {
      status: number;
      responseMode: "json" | "sse" | "none";
      responseBytes?: number | undefined;
      streamOutcome?: "completed" | "cancelled" | "errored" | "not_streamed" | undefined;
      outcome?: string | undefined;
      activeSessions?: number | undefined;
    }) => {
      const durationMs = now() - requestStartedAt;
      const outcome = args.outcome ?? mcpOutcome(args.status);
      recordUsageEvent(db, {
        tenantId: principal.tenant_id,
        surface: "mcp",
        operation: requestClass.operation,
        method: c.req.method,
        outcome,
        trafficClass,
        requestSource: "mcp",
        actorId: principal.id,
        sessionId: sessionHeader ?? undefined,
        statusCode: args.status,
        durationMs,
        requestBytes: Number(c.req.header("content-length") ?? "") || undefined,
        responseBytes: args.responseBytes,
        streamOutcome: args.streamOutcome,
        platform: "http",
        responseMode: args.responseMode,
        taskPhase: requestClass.taskPhase,
        activeSessions: args.activeSessions ?? sessions.size,
      });
      if (requestClass.operation === "tools/call:conversation") {
        recordUsageEvent(db, {
          tenantId: principal.tenant_id,
          surface: "conversations",
          operation: "mcp/call",
          method: c.req.method,
          outcome,
          trafficClass,
          requestSource: "mcp",
          actorId: principal.id,
          sessionId: sessionHeader ?? undefined,
          statusCode: args.status,
          durationMs,
          requestBytes: Number(c.req.header("content-length") ?? "") || undefined,
          responseBytes: args.responseBytes,
          streamOutcome: args.streamOutcome,
          platform: "http",
          responseMode: args.responseMode,
          taskPhase: requestClass.taskPhase,
        });
      }
    };

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
        recordRequest({ status: 404, responseMode: "json", streamOutcome: "not_streamed" });
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
        recordRequest({ status: 404, responseMode: "json", streamOutcome: "not_streamed" });
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

    // A fresh transport only earns a lease once `initialize` completes. Until
    // then nothing owns its server, so this request has to close it (below).
    let freshSession = false;
    let registered = false;

    if (!session) {
      // Hard-cap admission gate, BEFORE any server/transport is built. When
      // the map sits at `MAX_LIVE_SESSIONS_HARD` and every lease is busy,
      // `evictOverflow` can free nothing — admitting anyway is the unbounded
      // growth the hard cap exists to stop. 503 + Retry-After is the honest
      // answer: existing sessions keep working, and the client retries once
      // the sweeper (idle or stuck TTL) has reclaimed a lease.
      if (!hasAdmissionRoom()) {
        logger.warn({
          module: "mcp",
          action: "mcp.session.hard_cap_rejected",
          msg: "mcp session hard cap reached — rejecting new session with 503",
          sessions_open: sessions.size,
          hard_cap: MAX_LIVE_SESSIONS_HARD,
          principal_id: principal.id,
          tenant_id: principal.tenant_id,
        });
        recordRequest({ status: 503, responseMode: "json", streamOutcome: "not_streamed" });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Server is at its MCP session capacity — retry shortly",
            },
            id: null,
          }),
          {
            status: 503,
            headers: { "content-type": "application/json", "retry-after": "60" },
          },
        );
      }
      freshSession = true;
      // Spin up a new stateful transport. Per-session server so handlers
      // close over the current principal.
      const server = await createMcpServer({ db, principal, transport: "http" });
      // Assigned a few statements below, before `server.connect` and therefore
      // long before the SDK can invoke `onsessioninitialized` (it does so from
      // inside `handleRequest`). Held as a mutable binding rather than a
      // forward reference to a `const` declared further down, so the callback
      // does not depend on statement ordering it has no way to enforce.
      let lease: Session | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // OFF — see the header note: mid-tool-call `elicitation/create`
        // requests require the POST to keep an SSE stream open.
        enableJsonResponse: false,
        onsessioninitialized: (sid) => {
          if (!lease) {
            // Unreachable given the SDK's call order. If it ever fires, leaving
            // `registered` false is the fail-closed answer: the request's
            // `finally` closes the orphaned server instead of registering a
            // half-built lease.
            logger.warn({
              module: "mcp",
              action: "mcp.session.init_before_lease",
              msg: "mcp session initialized before its lease existed — refusing to register",
              session_id: sid,
              principal_id: principal.id,
            });
            return;
          }
          // The admission gate above ran before `createMcpServer`, but other
          // requests can interleave across those awaits — re-check here so a
          // race cannot register past the hard cap. Leaving `registered`
          // false makes the request's `finally` close the orphaned server;
          // the client's next request 404s and its re-initialize hits the
          // 503 gate.
          if (!evictOverflow()) {
            logger.warn({
              module: "mcp",
              action: "mcp.session.hard_cap_rejected",
              msg: "mcp session hard cap reached at initialize — refusing to register the lease",
              session_id: sid,
              sessions_open: sessions.size,
              hard_cap: MAX_LIVE_SESSIONS_HARD,
              principal_id: principal.id,
            });
            return;
          }
          registered = true;
          sessions.set(sid, lease);
          startSweeper();
          recordUsageEvent(db, {
            tenantId: principal.tenant_id,
            surface: "mcp",
            operation: "session/initialized",
            method: "POST",
            outcome: "success",
            trafficClass,
            requestSource: "mcp",
            actorId: principal.id,
            sessionId: sid,
            platform: "http",
            responseMode: "sse",
            activeSessions: sessions.size,
          });
          logger.info({
            module: "mcp",
            action: "mcp.session.init",
            msg: "mcp session initialized",
            session_id: sid,
            transport: "http",
            principal_id: principal.id,
            sessions_open: sessions.size,
          });
        },
        // Client sent `DELETE /mcp`. The SDK closes the transport right after
        // this callback, which walks the `onclose` chain and detaches the
        // capability listeners — so the map delete is all this owes.
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          if (sessions.size === 0) stopSweeper();
          recordUsageEvent(db, {
            tenantId: principal.tenant_id,
            surface: "mcp",
            operation: "session/closed",
            method: "DELETE",
            outcome: "success",
            trafficClass,
            requestSource: "mcp",
            actorId: principal.id,
            sessionId: sid,
            platform: "http",
            responseMode: "none",
            activeSessions: sessions.size,
          });
          logger.info({
            module: "mcp",
            action: "mcp.session.closed",
            msg: "mcp session closed",
            session_id: sid,
            sessions_open: sessions.size,
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
      // One `Session` object shared by the map and this request, so the
      // `retain` below accounts against the same lease the sweeper reads.
      lease = {
        transport,
        server,
        owner: ownerKey(principal),
        lastSeenAt: now(),
        inFlight: 0,
        usage: {
          db,
          tenantId: principal.tenant_id,
          actorId: principal.id,
          trafficClass,
        },
      };
      await server.connect(transport);
      session = lease;
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

    // Take a retain for this request and renew the lease. `handleRequest`
    // resolves as soon as it has a `Response` — for an SSE reply that is the
    // moment the stream OPENS, not the moment it closes — so entry-time
    // bookkeeping alone would let the sweeper terminate a live stream 30
    // minutes in. When the reply is an SSE body, the retain is handed to that
    // body (for a bounded lifetime — see `trackStreamLifetime`) and released
    // only when the stream ends, is cancelled, or errors; for every other reply
    // it is released here.
    const active = session;
    retain(active);
    let streamed = false;

    try {
      const response = await active.transport.handleRequest(c.req.raw);
      const body = response.body;
      if (!body || !isEventStream(response)) {
        recordRequest({
          status: response.status,
          responseMode: response.headers.get("content-type")?.includes("json") ? "json" : "none",
          responseBytes: Number(response.headers.get("content-length") ?? "") || undefined,
          streamOutcome: "not_streamed",
        });
        return response;
      }
      streamed = true;
      return new Response(
        trackMcpUsageStream(
          trackStreamLifetime(body, {
            release: () => release(active),
            reacquire: () => retain(active),
            onForceReleased: () =>
              logger.warn({
                module: "mcp",
                action: "mcp.session.retain_force_released",
                msg: "sse body moved no bytes within the retain silence window — releasing its lease retain so the sweeper can reclaim it",
                session_id: active.transport.sessionId ?? null,
                silent_ms: STREAM_RETAIN_SILENT_MS,
                principal_id: principal.id,
                tenant_id: principal.tenant_id,
              }),
          }),
          (streamOutcome, responseBytes) => {
            recordRequest({
              status: response.status,
              responseMode: "sse",
              responseBytes,
              streamOutcome,
              outcome: streamOutcome === "completed" ? mcpOutcome(response.status) : "disconnected",
            });
          },
        ),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } finally {
      if (!streamed) release(active);
      // The SDK awaits `onsessioninitialized` inside `handleRequest`, so by now
      // `registered` is authoritative: a fresh transport that never completed
      // the handshake (a non-initialize request with no session id self-rejects
      // — see `transport.onerror`) holds no lease and never will. Its server
      // still owns the capability modules' `globalEmitter` subscriptions, so
      // close it here or it leaks for the life of the process. Eviction only
      // ever touches registered sessions, so this cannot double-close.
      if (freshSession && !registered) {
        void active.server.close().catch((err: unknown) => {
          logger.warn({
            module: "mcp",
            action: "mcp.session.orphan_close_failed",
            msg: "failed to close mcp transport that never initialized",
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  });
}
