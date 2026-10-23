import { describe, expect, test } from "bun:test";
import {
  beginHttpShutdown,
  drainHttpBounded,
  type HttpShutdown,
  type ShutdownHttpServer,
} from "./shutdown.ts";

describe("HTTP shutdown", () => {
  test("stops admission, closes idle sockets, then exposes an explicit force-close", async () => {
    const calls: string[] = [];
    let finishClose: (() => void) | undefined;
    const server: ShutdownHttpServer = {
      close(callback) {
        calls.push("close");
        finishClose = callback;
      },
      closeIdleConnections() {
        calls.push("idle");
      },
      closeAllConnections() {
        calls.push("all");
        finishClose?.();
      },
    };

    const shutdown = beginHttpShutdown(server);
    expect(calls).toEqual(["close", "idle"]);

    shutdown.forceClose();
    expect(await shutdown.waitUntilClosed(20)).toBe(true);
    expect(calls).toEqual(["close", "idle", "all"]);
  });

  test("bounds the wait when a long-lived transport keeps the close callback pending", async () => {
    const server: ShutdownHttpServer = {
      close() {},
      closeAllConnections() {},
    };

    const shutdown = beginHttpShutdown(server);
    shutdown.forceClose();

    expect(await shutdown.waitUntilClosed(5)).toBe(false);
  });

  test("bounded drain reports closed, late close and an abandoned server", async () => {
    let finish: (() => void) | undefined;
    const prompt = beginHttpShutdown({
      close(callback) {
        finish = callback;
      },
      closeAllConnections() {
        finish?.();
      },
    });
    expect(await drainHttpBounded(prompt, { forceWaitMs: 5, abandonWaitMs: 5 })).toBe("closed");

    const answers = [false, true];
    const late: HttpShutdown = {
      closed: Promise.resolve(),
      forceClose() {},
      waitUntilClosed: async () => answers.shift() ?? false,
    };
    expect(await drainHttpBounded(late, { forceWaitMs: 5, abandonWaitMs: 100 })).toBe(
      "closed_after_force",
    );

    const stuck = beginHttpShutdown({ close() {}, closeAllConnections() {} });
    expect(await drainHttpBounded(stuck, { forceWaitMs: 5, abandonWaitMs: 5 })).toBe("abandoned");
  });
});
