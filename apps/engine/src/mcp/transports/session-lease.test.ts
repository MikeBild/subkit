// Session-lease idle sweeper — pure unit coverage against a fake clock.
//
// `createSessionLeaseManager` (see `session-lease.ts`) treats a map entry
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
  MAX_LIVE_SESSIONS_HARD,
  MAX_LIVE_SESSIONS_PER_OWNER,
  SESSION_IDLE_TTL_MS,
  SESSION_STUCK_TTL_MS,
  type Session,
} from "./session-lease.ts";

function fakeSession(
  lastSeenAt: number,
  inFlight = 0,
  owner = "tenant:actor:key",
): { session: Session; closed: () => boolean } {
  let closed = false;
  const server = {
    close: async () => {
      closed = true;
    },
  } as unknown as Server;
  const transport = {} as unknown as WebStandardStreamableHTTPServerTransport;
  return {
    session: { transport, server, owner, lastSeenAt, inFlight },
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
  // again: `lastSeenAt` ages past the idle TTL while the stream is very much
  // alive. Evicting it would close the server, close the transport, and kill
  // the stream out from under a connected client. It survives right up to the
  // stuck TTL, which is the backstop for a retain that never came back.
  test("a session holding an open stream is never idle, however old its lastSeenAt", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const streaming = fakeSession(clock.now());
      manager.sessions.set("notification-channel", streaming.session);
      manager.retain(streaming.session);

      clock.advanceBy(SESSION_STUCK_TTL_MS - 1);
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

      clock.advanceBy(SESSION_STUCK_TTL_MS - 1);
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

      expect(manager.evictOverflow()).toBe(true);

      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS);
      await Promise.resolve();
      expect(busy.every((s) => !s.closed())).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  // Over-cap admission is bounded. At the HARD ceiling with every lease busy
  // there is nothing left to evict and nothing left to admit — evictOverflow
  // must say no so the route handler answers 503 instead of growing the map
  // without bound (the observed 80×-in-a-row "admitting over cap" incident).
  // Owner spread matters here: the refusal path is only reachable when the map
  // is shared fairly. `owner-${i % 8}` puts 15 leases on each of 8 owners, well
  // under `MAX_LIVE_SESSIONS_PER_OWNER`, so no lease is a per-owner-share
  // victim and the honest answer really is "no room".
  test("at the hard cap with every lease busy and the map shared fairly, evictOverflow refuses admission and evicts nothing", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const busy = Array.from({ length: MAX_LIVE_SESSIONS_HARD }, (_, i) => {
        clock.advanceBy(1_000);
        const s = fakeSession(clock.now(), 1, `owner-${i % 8}`);
        manager.sessions.set(`busy-${i}`, s.session);
        return s;
      });

      expect(manager.evictOverflow()).toBe(false);
      expect(manager.hasAdmissionRoom()).toBe(false);

      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS_HARD);
      await Promise.resolve();
      expect(busy.every((s) => !s.closed())).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("hasAdmissionRoom is true below the hard cap, and true at the hard cap once a lease is evictable", () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      for (let i = 0; i < MAX_LIVE_SESSIONS_HARD - 1; i++) {
        manager.sessions.set(`busy-${i}`, fakeSession(clock.now(), 1, `owner-${i % 8}`).session);
      }
      // One under the hard cap: always admissible, busy or not.
      expect(manager.hasAdmissionRoom()).toBe(true);

      manager.sessions.set("last-busy", fakeSession(clock.now(), 1, "owner-7").session);
      expect(manager.hasAdmissionRoom()).toBe(false);

      // One lease finishes its work → the map has a victim again.
      const idle = manager.sessions.get("busy-0");
      expect(idle).toBeDefined();
      manager.release(idle!);
      expect(manager.hasAdmissionRoom()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  // A busy lease past the stuck TTL is a retain that never came back, not an
  // open stream — under capacity pressure it becomes the victim.
  test("at the hard cap, a stuck busy lease is evicted so admission can proceed", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const stuck = fakeSession(clock.now(), 1);
      manager.sessions.set("stuck", stuck.session);
      clock.advanceBy(SESSION_STUCK_TTL_MS + 1);
      for (let i = 1; i < MAX_LIVE_SESSIONS_HARD; i++) {
        manager.sessions.set(`busy-${i}`, fakeSession(clock.now(), 1).session);
      }
      expect(manager.hasAdmissionRoom()).toBe(true);

      expect(manager.evictOverflow()).toBe(true);

      expect(manager.sessions.has("stuck")).toBe(false);
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS_HARD - 1);
      await Promise.resolve();
      expect(stuck.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });
});

// Regression: one OAuth client re-initialized instead of reusing its session
// and held 118 of 120 leases, every one of them "busy". A SECOND credential on
// the same tenant could not open a single session — `hasAdmissionRoom` said no
// and every `initialize` got a 503, which its connector surfaced as a bare
// "Internal error". The map being full is not a reason to refuse the one client
// that holds none of it.
describe("createSessionLeaseManager · per-owner fair share", () => {
  test("a hogging owner loses its oldest lease instead of a different owner being refused", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      // One owner holds the entire map, all busy — the production shape.
      const hogOldest = fakeSession(clock.now(), 1, "tenant:actor:hog");
      manager.sessions.set("hog-oldest", hogOldest.session);
      for (let i = 1; i < MAX_LIVE_SESSIONS_HARD; i++) {
        clock.advanceBy(1_000);
        manager.sessions.set(`hog-${i}`, fakeSession(clock.now(), 1, "tenant:actor:hog").session);
      }
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS_HARD);

      // The newcomer is not refused …
      expect(manager.hasAdmissionRoom()).toBe(true);
      expect(manager.evictOverflow()).toBe(true);

      // … and the lease that paid for it is the hog's oldest, not anyone else's.
      expect(manager.sessions.has("hog-oldest")).toBe(false);
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS_HARD - 1);
      await Promise.resolve();
      expect(hogOldest.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("an owner at or under its share is never the victim; a well-shared map still refuses", () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      // Exactly `MAX_LIVE_SESSIONS_PER_OWNER` each — at the share, not over it.
      const owners = Math.ceil(MAX_LIVE_SESSIONS_HARD / MAX_LIVE_SESSIONS_PER_OWNER);
      for (let i = 0; i < MAX_LIVE_SESSIONS_HARD; i++) {
        clock.advanceBy(1_000);
        manager.sessions.set(`s-${i}`, fakeSession(clock.now(), 1, `owner-${i % owners}`).session);
      }

      expect(manager.hasAdmissionRoom()).toBe(false);
      expect(manager.evictOverflow()).toBe(false);
      expect(manager.sessions.size).toBe(MAX_LIVE_SESSIONS_HARD);
    } finally {
      restoreClock(prev);
    }
  });
});

describe("createSessionLeaseManager · stuck-lease sweep", () => {
  test("a busy lease untouched past SESSION_STUCK_TTL_MS is evicted by the sweeper", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const stuck = fakeSession(clock.now());
      manager.sessions.set("stuck-lease", stuck.session);
      manager.retain(stuck.session);

      clock.advanceBy(SESSION_STUCK_TTL_MS + 1);
      manager.tick();

      expect(manager.sessions.has("stuck-lease")).toBe(false);
      await Promise.resolve();
      expect(stuck.closed()).toBe(true);
    } finally {
      restoreClock(prev);
    }
  });

  test("a busy lease under the stuck TTL survives the sweep (never idle while in flight)", async () => {
    const clock = createDeterministicClock();
    const prev = installClock(clock);
    try {
      const manager = createSessionLeaseManager();
      const streaming = fakeSession(clock.now());
      manager.sessions.set("live-stream", streaming.session);
      manager.retain(streaming.session);

      clock.advanceBy(SESSION_STUCK_TTL_MS - 1);
      manager.tick();

      expect(manager.sessions.has("live-stream")).toBe(true);
      await Promise.resolve();
      expect(streaming.closed()).toBe(false);
    } finally {
      restoreClock(prev);
    }
  });
});
