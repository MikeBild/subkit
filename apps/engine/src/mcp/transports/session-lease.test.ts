// Session-lease idle sweeper — pure unit coverage against a fake clock.
//
// `createSessionLeaseManager` (see `streamable-http.ts`) treats a map entry
// as a LEASE, not a permanent allocation: an entry that outlives
// `SESSION_IDLE_TTL_MS` without a touch is evicted, which closes the
// underlying `server` (walking the SDK's `onclose` chain and detaching the
// `globalEmitter` listeners its capability modules registered). This test
// drives `tick()` directly with a deterministic clock instead of waiting on
// the real `SESSION_SWEEP_INTERVAL_MS` timer.

import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import {
  createSessionLeaseManager,
  MAX_LIVE_SESSIONS,
  SESSION_IDLE_TTL_MS,
  type Session,
} from "./streamable-http.ts";

function fakeSession(
  lastSeenAt: number,
  inFlight = 0,
): { session: Session; closed: () => boolean } {
  let closed = false;
  const server = {
    close: async () => {
      closed = true;
    },
  } as unknown as Server;
  const transport = {} as unknown as WebStandardStreamableHTTPServerTransport;
  return {
    session: { transport, server, owner: "tenant:actor:key", lastSeenAt, inFlight },
    closed: () => closed,
  };
}

describe("createSessionLeaseManager · idle sweep", () => {
  test("an idle session (past SESSION_IDLE_TTL_MS) is evicted: server.close() runs and the map shrinks", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const idle = fakeSession(clock.now());
      manager.sessions.set("idle-session", idle.session);
      expect(manager.sessions.size).toBe(1);

      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.tick();

      expect(manager.sessions.size).toBe(0);
      expect(manager.sessions.has("idle-session")).toBe(false);
      // `close()` is invoked fire-and-forget inside `evict` — await a
      // microtask turn so its promise settles before asserting.
      await Promise.resolve();
      expect(idle.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("a session touched within the TTL survives the sweep", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const fresh = fakeSession(clock.now());
      manager.sessions.set("fresh-session", fresh.session);

      // Advance to just under the TTL boundary — still within lease.
      clock.advanceBy(SESSION_IDLE_TTL_MS - 1);
      manager.tick();

      expect(manager.sessions.size).toBe(1);
      expect(manager.sessions.has("fresh-session")).toBe(true);
      await Promise.resolve();
      expect(fresh.closed()).toBe(false);
    } finally {
      restoreClock(prev);
    }
  });

  test("a touch (renewed lastSeenAt) resets the idle window so a later sweep does not evict it", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const session = fakeSession(clock.now());
      manager.sessions.set("renewed-session", session.session);

      // Almost idle out …
      clock.advanceBy(SESSION_IDLE_TTL_MS - 1);
      // … but a request touches it, renewing the lease (mirrors the route
      // handler's `active.lastSeenAt = now()` on every resolved request).
      const live = manager.sessions.get("renewed-session");
      expect(live).toBeDefined();
      live!.lastSeenAt = clock.now();

      // A sweep at this point must not evict it — it was just renewed.
      manager.tick();
      expect(manager.sessions.size).toBe(1);

      // Only once the FULL TTL has elapsed since the touch does it evict.
      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.tick();
      expect(manager.sessions.size).toBe(0);
    } finally {
      restoreClock(prev);
    }
  });

  test("sweeps only the idle sessions in a mixed map, leaving the fresh ones warm", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const stale = fakeSession(clock.now());
      manager.sessions.set("stale", stale.session);

      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      const fresh = fakeSession(clock.now());
      manager.sessions.set("fresh", fresh.session);

      manager.tick();

      expect(manager.sessions.has("stale")).toBe(false);
      expect(manager.sessions.has("fresh")).toBe(true);
      expect(manager.sessions.size).toBe(1);
      await Promise.resolve();
      expect(stale.closed()).toBe(true);
      expect(fresh.closed()).toBe(false);
    } finally {
      restoreClock(prev);
    }
  });

  // The standalone GET notification stream opens once and is never touched
  // again: `lastSeenAt` ages past the TTL while the stream is very much alive.
  // Evicting it would close the server, close the transport, and kill the
  // stream out from under a connected client.
  test("a session holding an open stream is never idle, however old its lastSeenAt", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const streaming = fakeSession(clock.now());
      manager.sessions.set("notification-channel", streaming.session);
      manager.retain(streaming.session);

      clock.advanceBy(SESSION_IDLE_TTL_MS * 10);
      manager.tick();

      expect(manager.sessions.has("notification-channel")).toBe(true);
      await Promise.resolve();
      expect(streaming.closed()).toBe(false);
    } finally {
      restoreClock(prev);
    }
  });

  test("once the stream closes, release re-dates the lease and a full idle TTL must elapse again", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const streaming = fakeSession(clock.now());
      manager.sessions.set("notification-channel", streaming.session);
      manager.retain(streaming.session);

      clock.advanceBy(SESSION_IDLE_TTL_MS * 10);
      manager.release(streaming.session);

      // Released, but `release` dated the lease to "now" — a stream that stayed
      // open for hours must not be swept the instant it closes.
      manager.tick();
      expect(manager.sessions.has("notification-channel")).toBe(true);

      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.tick();
      expect(manager.sessions.size).toBe(0);
      await Promise.resolve();
      expect(streaming.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("overlapping requests each take a retain; the lease stays busy until the last one releases", () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const busy = fakeSession(clock.now());
      manager.sessions.set("busy", busy.session);
      manager.retain(busy.session);
      manager.retain(busy.session);

      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.release(busy.session);
      expect(busy.session.inFlight).toBe(1);

      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.tick();
      expect(manager.sessions.has("busy")).toBe(true);

      manager.release(busy.session);
      expect(busy.session.inFlight).toBe(0);
      clock.advanceBy(SESSION_IDLE_TTL_MS + 1);
      manager.tick();
      expect(manager.sessions.size).toBe(0);
    } finally {
      restoreClock(prev);
    }
  });
});

describe("createSessionLeaseManager · evictOverflow", () => {
  test("at capacity, evicts the oldest-idle lease first to make room", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      // Fill to MAX_LIVE_SESSIONS so `evictOverflow` has to make room.
      const oldest = fakeSession(clock.now());
      manager.sessions.set("oldest", oldest.session);
      for (let i = 1; i < MAX_LIVE_SESSIONS; i++) {
        clock.advanceBy(1_000);
        manager.sessions.set(`filler-${i}`, fakeSession(clock.now()).session);
      }
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS);

      manager.evictOverflow();

      // The oldest-idle lease ("oldest", touched first) is the one dropped;
      // the map shrinks by exactly one to make room for the next lease.
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS - 1);
      expect(manager.sessions.has("oldest")).toBe(false);
      await Promise.resolve();
      expect(oldest.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("under capacity, evictOverflow is a no-op", () => {
    const manager = createSessionLeaseManager();
    manager.sessions.set("only-session", fakeSession(0).session);
    manager.evictOverflow();
    expect(manager.sessions.size).toBe(1);
    expect(manager.sessions.has("only-session")).toBe(true);
  });

  // "Oldest lastSeenAt" is the oldest request START. The session with the
  // longest-lived open stream therefore looks like the best victim and is in
  // fact the worst one — it is the only session doing work.
  test("the oldest lease is spared when it has in-flight work; the oldest idle one goes instead", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      // Oldest by lastSeenAt, but streaming: opened its notification channel first.
      const streaming = fakeSession(clock.now(), 1);
      manager.sessions.set("streaming", streaming.session);
      clock.advanceBy(1_000);
      const oldestIdle = fakeSession(clock.now());
      manager.sessions.set("oldest-idle", oldestIdle.session);
      for (let i = 2; i < MAX_LIVE_SESSIONS; i++) {
        clock.advanceBy(1_000);
        manager.sessions.set(`filler-${i}`, fakeSession(clock.now()).session);
      }
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS);

      manager.evictOverflow();

      expect(manager.sessions.has("streaming")).toBe(true);
      expect(manager.sessions.has("oldest-idle")).toBe(false);
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS - 1);
      await Promise.resolve();
      expect(streaming.closed()).toBe(false);
      expect(oldestIdle.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("when every lease is busy, evictOverflow admits over the cap rather than severing live work", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const busy = Array.from({ length: MAX_LIVE_SESSIONS }, (_, i) => {
        clock.advanceBy(1_000);
        const s = fakeSession(clock.now(), 1);
        manager.sessions.set(`busy-${i}`, s.session);
        return s;
      });

      manager.evictOverflow();

      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS);
      await Promise.resolve();
      expect(busy.every((s) => !s.closed())).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });
});
