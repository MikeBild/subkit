import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  DEFAULT_ENGINE_LISTEN_HOSTNAME,
  ENGINE_LISTEN_HOSTNAME,
  engineServeOptions,
  resolveListenHostname,
} from "../listen-hostname.ts";

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
    // bind-wildcard-allowed: this suite's SUBJECT is which address the server
    // binds, so the hostname is the parameter under test and cannot be pinned
    // to a literal here.
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
  const NO_OVERRIDE: NodeJS.ProcessEnv = {};

  test("ENGINE_LISTEN_HOSTNAME is 127.0.0.1 (the runtime constant)", () => {
    expect(ENGINE_LISTEN_HOSTNAME).toBe("127.0.0.1");
    expect(DEFAULT_ENGINE_LISTEN_HOSTNAME).toBe("127.0.0.1");
  });

  test("engineServeOptions(port) carries hostname=127.0.0.1 across arbitrary ports", () => {
    for (const port of [3000, 8080]) {
      const opts = engineServeOptions(port, NO_OVERRIDE);
      expect(opts.hostname, `hostname for port=${port}`).toBe(ENGINE_LISTEN_HOSTNAME);
      expect(opts.port, `port=${port}`).toBe(port);
    }
  });

  test("a server booted with engineServeOptions reports the same bind interface", async () => {
    const opts = engineServeOptions(0, NO_OVERRIDE);
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

  describe("ENGINE_LISTEN_HOST override (containers only)", () => {
    test("an explicit value widens the bind", () => {
      const opts = engineServeOptions(3000, { ENGINE_LISTEN_HOST: "0.0.0.0" });
      expect(opts.hostname).toBe("0.0.0.0");
      expect(opts.port).toBe(3000);
      expect(resolveListenHostname({ ENGINE_LISTEN_HOST: "::" })).toBe("::");
    });

    test("blank / whitespace / unset falls back to the loopback default", () => {
      expect(resolveListenHostname({ ENGINE_LISTEN_HOST: "" })).toBe(
        DEFAULT_ENGINE_LISTEN_HOSTNAME,
      );
      expect(resolveListenHostname({ ENGINE_LISTEN_HOST: "   " })).toBe(
        DEFAULT_ENGINE_LISTEN_HOSTNAME,
      );
      expect(resolveListenHostname(NO_OVERRIDE)).toBe(DEFAULT_ENGINE_LISTEN_HOSTNAME);
    });

    test("accepts well-formed hosts (IPv4, IPv6, hostname)", () => {
      for (const host of ["0.0.0.0", "127.0.0.1", "::", "::1", "localhost"]) {
        expect(resolveListenHostname({ ENGINE_LISTEN_HOST: host })).toBe(host);
      }
    });

    test("a non-empty but malformed value fails fast instead of binding the wrong interface", () => {
      for (const bad of ["0.0.0..1", "not a host", "10.0.0.1;rm"]) {
        expect(() => resolveListenHostname({ ENGINE_LISTEN_HOST: bad })).toThrow(
          /not a valid bind host/,
        );
      }
    });
  });
});
