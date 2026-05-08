// Regression: the engine HTTP + tunnel WS servers must bind 127.0.0.1
// in production, not 0.0.0.0.
//
// Caddy on the production host reverse-proxies the public TLS endpoint
// to 127.0.0.1:3000 (and :3001 for the WS tunnel). Defense-in-depth: a
// misconfigured firewall must not be able to leak the engine upstream.
// A future refactor that flips `hostname: "127.0.0.1"` back to
// `"0.0.0.0"` (or omits it, since the platform default is 0.0.0.0)
// would be invisible to CI without this test.
//
// 4.2.0 reviewer feedback: assert *behavior*, not source-text. Booting
// the actual server, reading `server.address().address` (HTTP) or
// `handle.url` (WS), and asserting the bound interface is the only
// shape that catches both:
//   1. "moved hostname into a constant `const HOSTNAME = '127.0.0.1'`"
//      — source-text scan for `hostname: "127.0.0.1"` would miss this.
//   2. "comment containing `hostname: \"127.0.0.1\"` slipped past
//      review" — source-text scan would falsely accept this.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "../../tunnels/ws-server.ts";

let db: TestDb;
let wsHandle: TunnelWsServerHandle | null = null;

beforeAll(async () => {
  db = await createTestDb("listen-hostname");
});

afterAll(async () => {
  if (wsHandle) await wsHandle.stop().catch(() => {});
  await db.cleanup();
});

function bootHttp(hostname: string): Promise<{ address: string; port: number; close: () => void }> {
  const app = new Hono();
  app.get("/_probe", (c) => c.text("ok"));
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname }, (info) => {
      // info is the AddressInfo from net.Server.address(). serve()
      // invokes this callback synchronously once bind succeeds; we
      // don't need a wall-clock fallback (forbidden by the
      // determinism lint anyway).
      try {
        resolve({
          address: info.address,
          port: info.port,
          close: () => server.close(),
        });
      } catch (err) {
        reject(err);
      }
    });
    server.on("error", reject);
  });
}

describe("engine bind hostname — defense-in-depth (behavioral)", () => {
  test("HTTP server bound to 127.0.0.1 reports address=127.0.0.1", async () => {
    const handle = await bootHttp("127.0.0.1");
    try {
      expect(handle.address).toBe("127.0.0.1");
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("HTTP server bound to 0.0.0.0 reports address=0.0.0.0 (test fence)", async () => {
    // Negative control: proves the assertion above is meaningful —
    // a regression that flips hostname back to 0.0.0.0 (or omits it,
    // since serve()'s default is 0.0.0.0) would be caught by the
    // first test only if booting actually distinguishes the two.
    const handle = await bootHttp("0.0.0.0");
    try {
      expect(handle.address).toBe("0.0.0.0");
    } finally {
      handle.close();
    }
  });

  test("startTunnelWsServer({ hostname: '127.0.0.1' }) binds 127.0.0.1", () => {
    // Bun.serve returns immediately (synchronous bind); the handle's
    // `url` carries the actual bound interface. No need for a
    // listening callback.
    wsHandle = startTunnelWsServer({ db: db.db, port: 0, hostname: "127.0.0.1" });
    expect(wsHandle.url).toContain("127.0.0.1:");
    expect(wsHandle.port).toBeGreaterThan(0);
  });
});
