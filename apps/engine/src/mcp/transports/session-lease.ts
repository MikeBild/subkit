// MCP session leases: the map, its idle/stuck sweeper, capacity eviction, and
// the per-stream retain accounting that feeds them.
//
// Split out of `streamable-http.ts` so the route handler is about routing and
// this file is about lifetime. Everything here is pure bookkeeping over a
// `Map` and the clock seam, which is why `session-lease.test.ts` can drive it
// against a deterministic clock with no HTTP in the picture.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { logger } from "../../logging/logger.ts";
import { recordUsageEvent, type TrafficClass } from "../../stats/usage-events.ts";
import { now } from "../../utils/clock.ts";

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
// Fair share of the map for one owner (`ownerKey`: tenant + actor + credential).
// The caps above are global, so without a per-owner share a single client that
// re-initializes instead of reusing its session owns the whole map and every
// OTHER principal is refused at the door. Production saw exactly that: one OAuth
// client held 118 of 120 leases while a second credential on the same tenant
// could not open a single session — its connector reported a bare "Internal
// error" for an hour. Consulted only at the hard cap with nothing else
// evictable, so a well-behaved client never comes near it.
export const MAX_LIVE_SESSIONS_PER_OWNER = Math.floor(MAX_LIVE_SESSIONS_HARD / 4);
// Lease timeout for busy leases. `inFlight > 0` normally means "live stream —
// never evict", but a retain that never comes back would pin its lease forever
// and, at scale, wedge the map at the cap with no victims. A lease that has
// seen NO request start or finish for this long is stuck, not busy —
// `retain`/`release` re-date `lastSeenAt` on every unit of work, so a genuinely
// active session never ages this far.
//
// This is the LAST line of defence, not the first: `STREAM_RETAIN_SILENT_MS`
// below hands a silent stream's retain back within minutes, so a lease only
// reaches this timeout if the retain accounting itself was bypassed. Production
// ran this at 12× the idle TTL (6 h) while no stream-level bound existed, and
// 120 dead-socket leases wedged the map for hours — `overflow_no_victim` on
// every admission, then a hard 503 for any client needing a NEW session. Six
// hours is far longer than it takes to refill the cap (observed: ~40 min), so
// the backstop has to sit much closer to the idle TTL.
export const SESSION_STUCK_TTL_MS = 2 * SESSION_IDLE_TTL_MS;
// A retain is bounded by LIVENESS, not by the stream's own promise to end.
//
// Two ways an SSE body pins `inFlight` at 1 forever if nothing bounds it: a
// body the runtime never attaches to a socket is never pulled and never
// cancelled; and a body that WAS pulled, whose client then vanished without a
// clean close, sits on a `read()` that never settles and a `cancel` that never
// comes. The second is the one that wedged production — the first `pull`
// arrives, and after it a dead stream is indistinguishable from a live-but-quiet
// one until something proves the socket dead.
//
// So the window is re-armed on every delivered PAYLOAD frame rather than
// disarmed on the first `pull`: a stream that has carried no payload for this
// long hands its retain back, and takes it straight back if one arrives. Sized
// above the longest legitimate silence on a live stream — `WF_INLINE_TIMEOUT_MS`
// (50 s), the gap between a tool call opening its POST stream and writing its
// JSON-RPC response — so a working tool call never gives up its retain
// mid-flight. Giving the retain back does not sever anything: it only makes the
// lease *eligible* for the idle sweeper a full `SESSION_IDLE_TTL_MS` later.
export const STREAM_RETAIN_SILENT_MS = 2 * 60_000;

/**
 * True when a chunk carries nothing but SSE comment frames — lines beginning
 * with `:`, which by the SSE grammar are ignored by every conforming client.
 *
 * This distinction is the whole point, and getting it wrong cost a production
 * verification: the MCP SDK arms its own keep-alive interval and writes
 * `": keepalive\\n\\n"` into every open SSE stream (see
 * `webStandardStreamableHttp.ts`, `_startKeepAlive`). Counting those bytes as
 * liveness measures THE SERVER WRITING, not the client receiving — and a peer
 * that has gone away still absorbs writes into the socket buffer without
 * erroring. So a dead notification channel produced a chunk every interval,
 * re-armed the window forever, and its lease was reclaimed only by the stuck
 * TTL: `reason: "stuck", idle_ms: 3659800` at exactly 61 minutes, never once by
 * the silence window.
 *
 * Only payload frames — anything the peer actually asked for — count. A live
 * client that simply has no notifications pending will let its retain go, which
 * costs nothing: the lease merely becomes idle-sweepable, and any real request
 * on the session re-dates it long before that.
 */
export function isKeepaliveOnly(chunk: Uint8Array): boolean {
  // Keep-alive frames are tiny; anything substantial is payload by definition
  // and not worth decoding.
  if (chunk.byteLength > 512) return false;
  const text = new TextDecoder().decode(chunk);
  if (text.trim().length === 0) return true;
  return text.split("\n").every((line) => line.trim().length === 0 || line.startsWith(":"));
}

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
  // from under a live stream. Every retain is bounded by liveness, not by the
  // stream ending: a body that carries no PAYLOAD for `STREAM_RETAIN_SILENT_MS`
  // hands its retain back (and reclaims it on the next payload frame), so
  // `inFlight` tracks streams that are demonstrably alive rather than streams
  // that merely never reported their own death.
  inFlight: number;
  /** Privacy-safe event context. Optional only for isolated lease-manager tests. */
  usage?: {
    db: import("../../db/client.ts").Db;
    tenantId: string;
    actorId: string;
    trafficClass: TrafficClass;
  };
}

// Stable key for the principal that owns a session. Ties the session to the
// authenticated identity (tenant + actor + credential), not to the session id
// alone, so a credential swap cannot ride an existing session.
//
// How far the credential term actually discriminates, per provider:
//   - api_key      — per key (`api_key_id`).
//   - session-based — per session (`session_id`).
//   - mcp_oauth    — per registered OAuth client (`oauth_client_id`), so two
//                    different clients authorised by the same user get separate
//                    sessions. Two tokens issued to the SAME client for the same
//                    user still share a key: the access-token id is not carried
//                    on the principal, so this stops cross-client reuse, not
//                    same-client token rotation.
//   - anything else — falls back to the provider name, which does not
//                    discriminate at all. No such provider reaches MCP today.
export function ownerKey(p: ResolvedPrincipal): string {
  return `${p.tenant_id}:${p.id}:${p.api_key_id ?? p.session_id ?? p.oauth_client_id ?? p.provider}`;
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
 * response is written. `release` then fires on normal end, client cancel, or
 * error.
 *
 * None of those endings arrive for a body whose client vanished without closing
 * the connection: `read()` never settles and `cancel` is never called. So the
 * retain is additionally bounded by LIVENESS — a window re-armed on every
 * delivered chunk. A stream silent for `STREAM_RETAIN_SILENT_MS` hands its
 * retain back so the sweeper can reclaim the lease; if a chunk does arrive
 * later, the stream proves itself alive and takes the retain back.
 *
 * `held` makes `release` and `reacquire` balanced in every ordering, so the
 * retain is never released twice and never leaked.
 */
export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  retain: StreamRetain,
  // The silence window is a real `setTimeout`, not the `utils/clock.ts` seam
  // (which only fakes `now()`), so tests inject a few milliseconds instead of
  // waiting out the production default.
  silentMs: number = STREAM_RETAIN_SILENT_MS,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let held = true;
  let closed = false;
  let silence: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (!silence) return;
    clearTimeout(silence);
    silence = undefined;
  };
  // Re-armed on every chunk. Fires only while the stream is open, holds the
  // retain, and has moved nothing for a full window. Deliberately does NOT
  // re-arm itself after firing: the retain is already back, and the next chunk
  // (if any) re-arms via `activity`.
  const arm = (): void => {
    disarm();
    silence = setTimeout(() => {
      silence = undefined;
      if (closed || !held) return;
      held = false;
      retain.release();
      retain.onForceReleased();
    }, silentMs);
    (silence as unknown as { unref?: () => void }).unref?.();
  };
  // A payload frame crossed the wire — the only evidence the peer is still
  // being served something it asked for. Keep-alive comment frames are written
  // by the server on its own timer and prove nothing (see `isKeepaliveOnly`).
  // Reclaims a force-released retain.
  const activity = (): void => {
    if (closed) return;
    if (!held) {
      held = true;
      retain.reacquire();
    }
    arm();
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    disarm();
    if (!held) return;
    held = false;
    retain.release();
  };

  // Armed before the first `pull`, so a body the runtime never attaches to a
  // socket is bounded by the same window as one that stalls after attaching.
  arm();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        if (!isKeepaliveOnly(chunk.value)) activity();
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

  // Last-resort victim when nothing is evictable: the oldest lease belonging to
  // an owner that is over `MAX_LIVE_SESSIONS_PER_OWNER`. Severing the hog's
  // oldest stream costs that client one reconnect; refusing admission instead
  // costs a DIFFERENT client all of its access, which is the strictly worse
  // trade. Returns undefined when the map is shared fairly — then a refusal is
  // honest and the caller answers 503.
  function dominantOwnerVictim(): string | undefined {
    const perOwner = new Map<string, number>();
    for (const session of sessions.values()) {
      perOwner.set(session.owner, (perOwner.get(session.owner) ?? 0) + 1);
    }
    let victimId: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of sessions) {
      if ((perOwner.get(session.owner) ?? 0) <= MAX_LIVE_SESSIONS_PER_OWNER) continue;
      if (session.lastSeenAt < oldestSeenAt) {
        oldestSeenAt = session.lastSeenAt;
        victimId = sessionId;
      }
    }
    return victimId;
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
          // At the ceiling with nothing evictable, refusing is only the honest
          // answer if the map is shared fairly. If one owner is over its share,
          // it pays for the overflow instead of the next arrival.
          const hog = dominantOwnerVictim();
          if (hog) {
            logger.warn({
              module: "mcp",
              action: "mcp.session.owner_share_evicted",
              msg: "mcp session hard cap reached with no evictable lease — evicting the oldest lease of an owner over its per-owner share",
              sessions_open: sessions.size,
              hard_cap: MAX_LIVE_SESSIONS_HARD,
              per_owner_cap: MAX_LIVE_SESSIONS_PER_OWNER,
              session_id: hog,
            });
            evict(hog, "capacity");
            return true;
          }
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
    // Nothing evictable — but `evictOverflow` will still take a lease off an
    // owner that is over its share rather than refuse. The probe has to agree
    // with the gate it guards, or admission 503s before that ever runs.
    return dominantOwnerVictim() !== undefined;
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
