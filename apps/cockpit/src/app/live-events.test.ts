import { describe, expect, test } from "bun:test";
import { backoffDelay, liveFrameKind, statusAfterStreamEnd } from "./live-events";
import { keysForEvent } from "./live-invalidation";

describe("frames of the live stream", () => {
  test("hello, heartbeat and the shutdown notice are told apart from changes", () => {
    expect(liveFrameKind("hello")).toBe("hello");
    expect(liveFrameKind("ping")).toBe("ping");
    expect(liveFrameKind("server.shutdown")).toBe("shutdown");
    expect(liveFrameKind("connector.auth_failed")).toBe("change");
  });

  test("a stopping engine shows as offline, a dropped connection as reconnecting", () => {
    expect(statusAfterStreamEnd(true)).toBe("offline");
    expect(statusAfterStreamEnd(false)).toBe("reconnecting");
  });

  test("the shutdown notice refreshes nothing and the reconnect backs off", () => {
    expect(keysForEvent("server.shutdown")).toEqual([]);
    expect([0, 1, 2, 3, 4, 9].map(backoffDelay)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000,
    ]);
  });
});
