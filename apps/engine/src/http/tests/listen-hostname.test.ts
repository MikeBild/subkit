// Regression: the engine HTTP server must bind 127.0.0.1 in production,
// not 0.0.0.0.
//
// Caddy on the production host reverse-proxies the public TLS endpoint
// to 127.0.0.1:3000. Defense-in-depth: a misconfigured firewall must
// not be able to leak the engine upstream. A future refactor that flips
// `hostname: "127.0.0.1"` back to `"0.0.0.0"` (or omits it, since the
// platform default is 0.0.0.0) would be invisible to CI without this
// test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { ENGINE_LISTEN_HOSTNAME, engineServeOptions } from "../listen-hostname.ts";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("listen-hostname");
});

afterAll(async () => {
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
    expect(ENGINE_LISTEN_HOSTNAME).toBe("127.0.0.1");
  });

  test("engineServeOptions(port) carries hostname=127.0.0.1 across arbitrary ports", () => {
    // Two distinct ports keep the helper honest — the signature must
    // echo the input through, not silently substitute a constant.
    for (const port of [3000, 8080]) {
      const opts = engineServeOptions(port);
      expect(opts.hostname, `hostname for port=${port}`).toBe(ENGINE_LISTEN_HOSTNAME);
      expect(opts.port, `port=${port}`).toBe(port);
    }
  });

  test("a server booted with engineServeOptions reports the same bind interface", async () => {
    const opts = engineServeOptions(0);
    const handle = await bootHttp(opts.hostname);
    try {
      expect(handle.address).toBe(ENGINE_LISTEN_HOSTNAME);
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("a server bound to 0.0.0.0 reports 0.0.0.0 (negative control)", async () => {
    const handle = await bootHttp("0.0.0.0");
    try {
      expect(handle.address).toBe("0.0.0.0");
    } finally {
      handle.close();
    }
  });
});
