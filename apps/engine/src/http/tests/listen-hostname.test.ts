// Regression: the engine HTTP server must bind 127.0.0.1, not 0.0.0.0.
//
// Caddy on the production host reverse-proxies the public TLS endpoint
// to 127.0.0.1:3000. Defense-in-depth: a misconfigured firewall must
// not be able to leak the engine upstream. A future refactor that
// flips `hostname: "127.0.0.1"` back to `"0.0.0.0"` (or omits it,
// since `serve()`'s default is 0.0.0.0) would be invisible to CI
// without this test.
//
// We assert the literal source-text rather than booting a server and
// reading `address.address` because @hono/node-server doesn't surface
// the bound interface through a public API on its return value, and
// the regression we're guarding (a single-line edit) is itself a
// source-text change.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE_INDEX = join(import.meta.dir, "..", "..", "index.ts");
const TUNNEL_WS = join(import.meta.dir, "..", "..", "tunnels", "ws-server.ts");

describe("engine bind hostname — defense-in-depth", () => {
  test("HTTP server binds 127.0.0.1 (not 0.0.0.0)", () => {
    const src = readFileSync(ENGINE_INDEX, "utf8");
    expect(src).toContain('hostname: "127.0.0.1"');
    expect(src).not.toContain('hostname: "0.0.0.0"');
  });

  test("HTTP server's `serve()` call passes an explicit hostname", () => {
    const src = readFileSync(ENGINE_INDEX, "utf8");
    // Match `serve({ fetch: …, port, hostname: "127.0.0.1" })` — at
    // minimum, the call must contain `hostname:` to fence accidental
    // omission.
    expect(src).toMatch(/serve\(\{\s*fetch:[\s\S]+?hostname:\s*"127\.0\.0\.1"/);
  });

  test("tunnel WS server is invoked with hostname=127.0.0.1", () => {
    const src = readFileSync(ENGINE_INDEX, "utf8");
    // startTunnelWsServer's call site in index.ts threads the host
    // through opts.hostname.
    expect(src).toMatch(/startTunnelWsServer\(\{[\s\S]+?hostname:\s*"127\.0\.0\.1"/);
  });

  test("tunnel WS server module accepts a hostname option", () => {
    const src = readFileSync(TUNNEL_WS, "utf8");
    // The default in ws-server.ts is permissive (0.0.0.0) for local
    // dev — index.ts overrides with 127.0.0.1. The contract here is
    // that the option exists at all.
    expect(src).toMatch(/hostname[:?].+?opts\.hostname/);
  });
});
