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

// A session is a lease, not a permanent allocation. The spec has clients send
// `DELETE /mcp` when they are done and almost none do, so `onsessionclosed`
// fires for a rounding error's worth of the sessions that `initialize` opens.
// Every orphaned entry pins an `McpServer` + transport AND the `globalEmitter`
// subscriptions its capability modules registered, so each `workflow.lifecycle`
// event fans out across every session this process ever saw — an RSS leak and a
// CPU leak. The sweeper below makes the map a TTL cache: a lease lives only as
// long as requests keep touching it.
export const SESSION_IDLE_TTL_MS = 30 * 60_000;
export const SESSION_SWEEP_INTERVAL_MS = 60_000;
// Soft ceiling on concurrent leases, so a client that re-initializes on every
// call cannot outrun the sweeper. Oldest-idle lease is evicted first. When
// every lease is busy the map may run over this cap — but only up to
// `MAX_LIVE_SESSIONS_HARD`.
export const MAX_LIVE_SESSIONS = 100;
// Hard ceiling. The soft cap admits over itself when every lease has in-flight
// work (severing live streams is worse than a bigger map) — but observed
// production runs latched 80× "admitting over cap" in a row, so "every lease
// is busy" is not a state that self-corrects fast enough to leave admission
// unbounded. At the hard ceiling a fresh `initialize` is refused with a 503
// instead of admitted; existing sessions keep working.
export const MAX_LIVE_SESSIONS_HARD = 120;
// Lease timeout for busy leases. `inFlight > 0` normally means "live stream —
// never evict", but a retain that never comes back (a transport whose
// `onClosed` never fired, a stream the runtime lost track of) would pin its
// lease forever and, at scale, wedge the map at the cap with no victims. A
// lease that has seen NO request start or finish for this long is stuck, not
// busy — `retain`/`release` re-date `lastSeenAt` on every unit of work, so a
// genuinely active session never ages this far. Kept well above the idle TTL
// so a long-lived standalone GET notification channel on a quiet but connected
// client is not severed prematurely (the existing sweeper tests pin survival
// at 10× the idle TTL).
export const SESSION_STUCK_TTL_MS = 12 * SESSION_IDLE_TTL_MS;
// A retain is bounded, like the lease it accounts against. An SSE body the
// runtime never attaches to a socket is never pulled and never cancelled, so
// its `onClosed` never fires and its retain pins `inFlight` at 1 forever — the
// sweeper skips the lease and `evictOverflow` can never reclaim it. A stream
// that has produced nothing and been neither pulled nor cancelled inside this
// window is not in flight. Real consumers issue their first `pull` in the same
// microtask the Response is returned in, so this only ever fires on a body
// nobody took.
export const STREAM_RETAIN_START_GRACE_MS = 30_000;

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  // Owner identity captured at `initialize`. The per-session `server` closes
  // over this principal's tenant/permissions, so every later request on this
  // session id MUST come from the same principal — otherwise a leaked session
  // id would let a second valid token execute inside the owner's tenant
  // context (MCP Security Best Practices: sessions MUST NOT be used for
  // authentication; bind the session id to the authorized user).
  owner: string;
  // Wall clock of the request that most recently started or finished on this
  // session. Written by the request path (`retain` / `release`) only; the
  // sweeper reads it. Renewing the lease from the sweeper would make an idle
  // session immortal.
  lastSeenAt: number;
  // Open units of work: a request still inside `handleRequest`, plus every SSE
  // body that request handed back — the standalone GET notification channel
  // (open for the life of the client's session) and each POST response stream
  // (open until its JSON-RPC response is written). A session with
  // `inFlight > 0` is not idle, and evicting it would close the transport out
  // from under a live stream. Every retain is bounded: a stream body nobody
  // consumed hands its retain back after `STREAM_RETAIN_START_GRACE_MS`, so
  // `inFlight` can never latch above zero.
  inFlight: number;
  /** Privacy-safe event context. Optional only for isolated lease-manager tests. */
  usage?: {
    db: import("../../db/client.ts").Db;
    tenantId: string;
    actorId: string;
    trafficClass: TrafficClass;
  };
}

interface McpRequestClass {
  operation: string;
  taskPhase?: "working" | "cancelled" | "none" | undefined;
}

const JSON_RPC_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
]);

function toolClass(name: unknown): string {
  if (typeof name !== "string") return "other";
  if (name.startsWith("conversation_")) return "conversation";
  if (name.includes("workflow")) return "workflow";
  if (name.includes("knowledge") || name.includes("search_")) return "knowledge";
  if (name.includes("connector") || name.includes("probe")) return "connector";
  if (name.includes("execution") || name.startsWith("run_")) return "execution";
  return "other";
}

async function classifyMcpRequest(request: Request): Promise<McpRequestClass> {
  if (request.method === "GET") return { operation: "notifications/stream" };
  if (request.method === "DELETE") return { operation: "session/close" };
  if (request.method !== "POST") return { operation: "transport/other" };
  try {
    const value = (await request.clone().json()) as unknown;
    if (Array.isArray(value)) return { operation: "jsonrpc/batch" };
    if (!value || typeof value !== "object") return { operation: "jsonrpc/invalid" };
    const envelope = value as { method?: unknown; params?: unknown };
    const rawMethod = typeof envelope.method === "string" ? envelope.method : "";
    const method = JSON_RPC_METHODS.has(rawMethod) ? rawMethod : "jsonrpc/other";
    if (method === "tools/call") {
      const params =
        envelope.params && typeof envelope.params === "object"
          ? (envelope.params as { name?: unknown; task?: unknown })
          : {};
      return {
        operation: `tools/call:${toolClass(params.name)}`,
        taskPhase: params.task === undefined ? "none" : "working",
      };
    }
    if (method === "tasks/cancel") return { operation: method, taskPhase: "cancelled" };
    return { operation: method };
  } catch {
    return { operation: "jsonrpc/invalid" };
  }
}

function mcpOutcome(status: number): string {
  if (status === 503) return "capacity_rejected";
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}

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

// Stable key for the principal that owns a session. Ties the session to the
// authenticated identity (tenant + actor + credential), not to the session id
// alone. Two distinct tokens — even for the same user — produce different keys
// so a token swap cannot ride an existing session.
function ownerKey(p: ResolvedPrincipal): string {
  return `${p.tenant_id}:${p.id}:${p.api_key_id ?? p.session_id ?? p.provider}`;
}

export interface SessionLeaseManager {
  sessions: Map<string, Session>;
  evict(sessionId: string, reason: "idle_ttl" | "capacity" | "stuck"): void;
  /** One sweep pass: evict every session idle past `SESSION_IDLE_TTL_MS`
   *  and every busy lease stuck past `SESSION_STUCK_TTL_MS`.
   *  Exposed separately from `startSweeper` so tests can drive a pass
   *  deterministically (fake clock + direct call) instead of waiting on the
   *  real `SESSION_SWEEP_INTERVAL_MS` timer. */
  tick(): void;
  startSweeper(): void;
  stopSweeper(): void;
  /** Make room for one more lease. Returns false when the map is at
   *  `MAX_LIVE_SESSIONS_HARD` and no lease is evictable — the caller must
   *  refuse the admission instead of registering over the hard ceiling. */
  evictOverflow(): boolean;
  /** Read-only admission probe for the request path: true when a fresh lease
   *  could be admitted right now (below the hard ceiling, or an evictable
   *  lease exists for `evictOverflow` to reclaim). */
  hasAdmissionRoom(): boolean;
  /** Mark one unit of work as started on this session. Must be paired with
   *  exactly one `release`. */
  retain(session: Session): void;
  /** Mark one unit of work as finished, and date the lease from that moment —
   *  a stream that stayed open for an hour has an hour-old `lastSeenAt` and
   *  would otherwise be swept the instant it closed. */
  release(session: Session): void;
}

/** The three moves a tracked stream makes against its session's retain. */
interface StreamRetain {
  /** Give the retain back — the stream ended, was cancelled, or never started. */
  release(): void;
  /** Take the retain again after a force-release, because the stream turned out
   *  to be live after all. Keeps "a genuinely active stream is never swept". */
  reacquire(): void;
  /** The force-release fired: a body nobody pulled or cancelled. */
  onForceReleased(): void;
}

/**
 * Hand a session's in-flight retain to the response body it produced, for a
 * BOUNDED lifetime. An SSE body outlives the `handleRequest` promise by design:
 * the standalone GET notification channel stays open for the life of the
 * session, and a POST response stream stays open until the tool's JSON-RPC
 * response is written. `release` then fires exactly once — on normal end,
 * client cancel, or error.
 *
 * A body that is never consumed has none of those endings. Its retain is
 * force-released once `STREAM_RETAIN_START_GRACE_MS` passes with no `pull` and
 * no `cancel`; if a first `pull` arrives after that, the stream is live and
 * takes the retain back. `release` and `reacquire` are therefore balanced in
 * every ordering, and the retain is never released twice.
 */
function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  retain: StreamRetain,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let started = false;
  let held = true;
  let closed = false;
  let grace: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    grace = undefined;
    if (started || closed) return;
    held = false;
    retain.release();
    retain.onForceReleased();
  }, STREAM_RETAIN_START_GRACE_MS);
  (grace as unknown as { unref?: () => void }).unref?.();

  const disarm = (): void => {
    if (!grace) return;
    clearTimeout(grace);
    grace = undefined;
  };
  // First evidence the stream is alive. Reclaims a force-released retain.
  const activate = (): void => {
    started = true;
    disarm();
    if (held) return;
    held = true;
    retain.reacquire();
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    disarm();
    if (!held) return;
    held = false;
    retain.release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      activate();
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}

// Only SSE bodies outlive `handleRequest`. Buffered JSON errors and 202s are
// complete the moment they are returned, so they must not pin a lease.
function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

/**
 * Session-lease bookkeeping (map + idle sweeper + overflow eviction), pulled
 * out of `registerMcpHttpRoutes` so it can be unit tested against a fake
 * clock instead of a real 60s `setInterval` tick. Reads "now" through the
 * production clock seam (`utils/clock.ts`) — tests install a deterministic
 * override via `installClock` and drive `startSweeper`'s tick manually
 * without waiting on wall-clock time.
 */
export function createSessionLeaseManager(): SessionLeaseManager {
  const sessions = new Map<string, Session>();
  let sweeper: ReturnType<typeof setInterval> | undefined;

  // Drop the lease and close the server, which walks the SDK's `onclose` chain
  // (`capabilities/tools.ts`, `capabilities/resources.ts`) and detaches their
  // `globalEmitter` listeners. Closing is fire-and-forget: the map entry is gone
  // either way, and a client that returns finds a 404 and re-initializes.
  function evict(sessionId: string, reason: "idle_ttl" | "capacity" | "stuck"): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.usage) {
      recordUsageEvent(session.usage.db, {
        tenantId: session.usage.tenantId,
        surface: "mcp",
        operation: "session/evicted",
        method: "DELETE",
        outcome: reason === "capacity" ? "capacity_rejected" : "cancelled",
        trafficClass: session.usage.trafficClass,
        requestSource: "mcp",
        actorId: session.usage.actorId,
        sessionId,
        platform: "http",
        responseMode: "none",
        activeSessions: sessions.size,
      });
    }
    logger.info({
      module: "mcp",
      action: "mcp.session.evicted",
      msg: "mcp session evicted",
      session_id: sessionId,
      reason,
      idle_ms: now() - session.lastSeenAt,
      sessions_open: sessions.size,
    });
    void session.server.close().catch((err: unknown) => {
      logger.warn({
        module: "mcp",
        action: "mcp.session.evict_failed",
        msg: "failed to close evicted mcp session",
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function stopSweeper(): void {
    if (!sweeper) return;
    clearInterval(sweeper);
    sweeper = undefined;
  }

  function retain(session: Session): void {
    session.inFlight += 1;
    session.lastSeenAt = now();
  }

  function release(session: Session): void {
    if (session.inFlight > 0) session.inFlight -= 1;
    session.lastSeenAt = now();
  }

  // Idleness is "no work, and none for a full TTL". A session serving an open
  // SSE stream is doing work no matter how old its `lastSeenAt` is: eviction
  // closes the server, which closes the transport, which kills that stream.
  // EXCEPT past the stuck TTL: a busy lease that no request has started or
  // finished on for `SESSION_STUCK_TTL_MS` is a retain that never came back,
  // and leaving it immortal is how the map wedges at the cap with no victims.
  function tick(): void {
    const cutoff = now() - SESSION_IDLE_TTL_MS;
    const stuckCutoff = now() - SESSION_STUCK_TTL_MS;
    for (const [sessionId, session] of sessions) {
      if (session.inFlight > 0) {
        if (session.lastSeenAt <= stuckCutoff) evict(sessionId, "stuck");
        continue;
      }
      if (session.lastSeenAt <= cutoff) evict(sessionId, "idle_ttl");
    }
    if (sessions.size === 0) stopSweeper();
  }

  // Armed on the first lease and disarmed with the last one, so a process with
  // no MCP traffic (and every test that builds an app) never holds a timer.
  // `unref` on top of that so a live sweeper cannot hold the loop open either.
  function startSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(tick, SESSION_SWEEP_INTERVAL_MS);
    (sweeper as unknown as { unref?: () => void }).unref?.();
  }

  // A lease is evictable when it holds no in-flight work, or when its work
  // has been in flight with no request activity for the full stuck TTL —
  // shared by `evictOverflow` (actual eviction) and `hasAdmissionRoom` (the
  // request path's read-only probe).
  function isEvictable(session: Session, stuckCutoff: number): boolean {
    return session.inFlight === 0 || session.lastSeenAt <= stuckCutoff;
  }

  // Make room for one more lease. Oldest-idle first: a session nobody has
  // touched is the cheapest one to lose. Sessions with in-flight work are only
  // victims once they age past the stuck TTL — a lease holding an open
  // notification stream is the most valuable one in the map, not the least,
  // and killing it strands a live client.
  function evictOverflow(): boolean {
    while (sessions.size >= MAX_LIVE_SESSIONS) {
      const stuckCutoff = now() - SESSION_STUCK_TTL_MS;
      let oldestId: string | undefined;
      let oldestSeenAt = Number.POSITIVE_INFINITY;
      let oldestBusy = false;
      for (const [sessionId, session] of sessions) {
        if (!isEvictable(session, stuckCutoff)) continue;
        if (session.lastSeenAt < oldestSeenAt) {
          oldestSeenAt = session.lastSeenAt;
          oldestId = sessionId;
          oldestBusy = session.inFlight > 0;
        }
      }
      if (!oldestId) {
        // Every lease is busy (and none is stuck yet). Between the soft and
        // hard caps, admit over the cap rather than sever live work; the
        // sweeper reclaims leases as their streams close. AT the hard cap,
        // refuse — unbounded admission is how 80 consecutive over-cap warns
        // happened in production.
        if (sessions.size >= MAX_LIVE_SESSIONS_HARD) {
          logger.warn({
            module: "mcp",
            action: "mcp.session.hard_cap_reached",
            msg: "mcp session hard cap reached and every lease has in-flight work — refusing new session",
            sessions_open: sessions.size,
            hard_cap: MAX_LIVE_SESSIONS_HARD,
          });
          return false;
        }
        logger.warn({
          module: "mcp",
          action: "mcp.session.overflow_no_victim",
          msg: "mcp session cap reached but every lease has in-flight work — admitting over cap",
          sessions_open: sessions.size,
        });
        return true;
      }
      evict(oldestId, oldestBusy ? "stuck" : "capacity");
    }
    return true;
  }

  function hasAdmissionRoom(): boolean {
    if (sessions.size < MAX_LIVE_SESSIONS_HARD) return true;
    const stuckCutoff = now() - SESSION_STUCK_TTL_MS;
    for (const session of sessions.values()) {
      if (isEvictable(session, stuckCutoff)) return true;
    }
    return false;
  }

  return {
    sessions,
    evict,
    tick,
    startSweeper,
    stopSweeper,
    evictOverflow,
    hasAdmissionRoom,
    retain,
    release,
  };
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
                msg: "sse body was never pulled or cancelled within the retain grace — releasing its lease retain so the sweeper can reclaim it",
                session_id: active.transport.sessionId ?? null,
                grace_ms: STREAM_RETAIN_START_GRACE_MS,
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
