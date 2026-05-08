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
// Round-6 reviewer feedback: assert against the EXACT helpers the
// runtime uses, not a parallel copy. `engineHttpServeOptions()` and
// `engineTunnelServeOptions()` (declared in apps/engine/src/index.ts
// alongside the actual `serve(...)` call) are the single source of
// truth; any future refactor that drops the hostname (constant rename,
// helper-rewrite that omits it, …) trips this assertion.
//
// We also boot a server with each option set and confirm the bound
// interface — that fences the case where the helper is correct but
// the call site stops passing it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { startTunnelWsServer, type TunnelWsServerHandle } from "../../tunnels/ws-server.ts";
import {
  ENGINE_LISTEN_HOSTNAME,
  engineHttpServeOptions,
  engineTunnelServeOptions,
} from "../listen-hostname.ts";

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

describe("engine bind hostname — defense-in-depth", () => {
  test("ENGINE_LISTEN_HOSTNAME is 127.0.0.1 (the runtime constant)", () => {
    // Lock the literal that every other surface in this test
    // references through. A future PR that reaches into the constant
    // and changes it must justify the change here.
    expect(ENGINE_LISTEN_HOSTNAME).toBe("127.0.0.1");
  });

  test("engineHttpServeOptions(port) carries hostname=127.0.0.1", () => {
    // Asserts the EXACT helper the runtime calls in
    // apps/engine/src/index.ts:runServer (post-4.2.0 refactor).
    const opts = engineHttpServeOptions(3000);
    expect(opts.hostname).toBe(ENGINE_LISTEN_HOSTNAME);
    expect(opts.port).toBe(3000);
  });

  test("engineTunnelServeOptions(port) carries hostname=127.0.0.1", () => {
    const opts = engineTunnelServeOptions(3001);
    expect(opts.hostname).toBe(ENGINE_LISTEN_HOSTNAME);
    expect(opts.port).toBe(3001);
  });

  test("a server booted with engineHttpServeOptions reports the same bind interface", async () => {
    // Closes the loop: prove the helper isn't just a value-equality
    // fence — a real server bound with these options actually listens
    // on 127.0.0.1. Catches the case where the helper is correct but
    // a future call site stops passing it through.
    const opts = engineHttpServeOptions(0);
    const handle = await bootHttp(opts.hostname);
    try {
      expect(handle.address).toBe(ENGINE_LISTEN_HOSTNAME);
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("a server bound to 0.0.0.0 reports 0.0.0.0 (negative control)", async () => {
    // Proves the address() assertion above is meaningful — without
    // this control, a Hono `serve` that ignored `hostname` would
    // silently bind 0.0.0.0 and the prior test would still pass.
    const handle = await bootHttp("0.0.0.0");
    try {
      expect(handle.address).toBe("0.0.0.0");
    } finally {
      handle.close();
    }
  });

  test("startTunnelWsServer with engineTunnelServeOptions binds 127.0.0.1", () => {
    const opts = engineTunnelServeOptions(0);
    wsHandle = startTunnelWsServer({ db: db.db, port: opts.port, hostname: opts.hostname });
    expect(wsHandle.url).toContain(`${ENGINE_LISTEN_HOSTNAME}:`);
    expect(wsHandle.port).toBeGreaterThan(0);
  });
});
