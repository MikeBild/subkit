import { describe, expect, test } from "bun:test";
import { beginHttpShutdown, type ShutdownHttpServer } from "./shutdown.ts";

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
    await shutdown.closed;
    expect(calls).toEqual(["close", "idle", "all"]);
  });
});
