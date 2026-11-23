import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { METRICS_SCOPE } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import { ForbiddenError, UnauthorizedError } from "../../http/errors.ts";
import { requireAuth } from "../../http/middleware/auth.ts";
import type { AppEnv } from "../../http/openapi.ts";
import { logger } from "../../logging/index.ts";
import { recordUsageEvent, trafficClassFromHeader } from "../../stats/index.ts";
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

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

export function registerMcpHttpRoutes(app: OpenAPIHono<AppEnv>): void {
  const { sessions, startSweeper, stopSweeper, evictOverflow, hasAdmissionRoom, retain, release } =
    createSessionLeaseManager();

  app.all("/mcp", async (c) => {
    const requestStartedAt = now();
    const requestClassPromise = classifyMcpRequest(c.req.raw);
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
      let scopes = "mcp:read";
      try {
        const config = getConfig();
        baseUrl = config.server.public_base_url;
        const hinted = config.auth.mcp_oauth.scopes_supported.filter(
          (scope) => scope !== METRICS_SCOPE,
        );
        if (hinted.length > 0) scopes = hinted.join(" ");
      } catch {}
      const wwwAuth = baseUrl
        ? `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${scopes}"`
        : `Bearer scope="${scopes}"`;
      throw new UnauthorizedError("missing_or_invalid_credentials", wwwAuth);
    }
    const principal = requireAuth(c);
    if (principal.product_id) throw new ForbiddenError("product_caller_forbidden");
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

    let freshSession = false;
    let registered = false;

    if (!session) {
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
      const server = await createMcpServer({ db, principal, transport: "http" });
      let lease: Session | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: false,
        maxRequestBodySize: 6 * 1024 * 1024,
        onsessioninitialized: (sid) => {
          if (!lease) {
            logger.warn({
              module: "mcp",
              action: "mcp.session.init_before_lease",
              msg: "mcp session initialized before its lease existed — refusing to register",
              session_id: sid,
              principal_id: principal.id,
            });
            return;
          }
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

    if (c.req.method === "GET") {
      session.transport.closeStandaloneSSEStream();
    }

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
