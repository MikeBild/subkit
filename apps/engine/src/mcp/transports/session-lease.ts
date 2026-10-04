import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { logger } from "../../logging/logger.ts";
import { recordUsageEvent, type TrafficClass } from "../../stats/usage-events.ts";
import { now } from "../../utils/clock.ts";

export const SESSION_IDLE_TTL_MS = 30 * 60_000;
export const SESSION_SWEEP_INTERVAL_MS = 60_000;
export const MAX_LIVE_SESSIONS = 100;
export const MAX_LIVE_SESSIONS_HARD = 120;
export const MAX_LIVE_SESSIONS_PER_OWNER = Math.floor(MAX_LIVE_SESSIONS_HARD / 4);
export const SESSION_STUCK_TTL_MS = 2 * SESSION_IDLE_TTL_MS;
export const STREAM_RETAIN_SILENT_MS = 2 * 60_000;

export function isKeepaliveOnly(chunk: Uint8Array): boolean {
  if (chunk.byteLength > 512) return false;
  const text = new TextDecoder().decode(chunk);
  if (text.trim().length === 0) return true;
  return text.split("\n").every((line) => line.trim().length === 0 || line.startsWith(":"));
}

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  owner: string;
  lastSeenAt: number;
  inFlight: number;
  usage?: {
    db: import("../../db/client.ts").Db;
    tenantId: string;
    actorId: string;
    trafficClass: TrafficClass;
  };
}

export function ownerKey(p: ResolvedPrincipal): string {
  return `${p.tenant_id}:${p.id}:${p.api_key_id ?? p.session_id ?? p.oauth_client_id ?? p.provider}`;
}

export interface SessionLeaseManager {
  sessions: Map<string, Session>;
  evict(sessionId: string, reason: "idle_ttl" | "capacity" | "stuck"): void;
  tick(): void;
  startSweeper(): void;
  stopSweeper(): void;
  evictOverflow(): boolean;
  hasAdmissionRoom(): boolean;
  retain(session: Session): void;
  release(session: Session): void;
}

interface StreamRetain {
  release(): void;
  reacquire(): void;
  onForceReleased(): void;
}

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  retain: StreamRetain,
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

export function createSessionLeaseManager(): SessionLeaseManager {
  const sessions = new Map<string, Session>();
  let sweeper: ReturnType<typeof setInterval> | undefined;

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

  function startSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(tick, SESSION_SWEEP_INTERVAL_MS);
    (sweeper as unknown as { unref?: () => void }).unref?.();
  }

  function isEvictable(session: Session, stuckCutoff: number): boolean {
    return session.inFlight === 0 || session.lastSeenAt <= stuckCutoff;
  }

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
        if (sessions.size >= MAX_LIVE_SESSIONS_HARD) {
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
