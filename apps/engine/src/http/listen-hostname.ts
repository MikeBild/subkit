// Listen-hostname helpers — single source of truth for the bind
// interface every engine listener (HTTP + tunnel WS) targets.
//
// Lives in its own leaf module (no side effects on import) so the
// regression test in apps/engine/src/http/tests/listen-hostname.test.ts
// can assert against the EXACT shape the runtime calls — without
// triggering `apps/engine/src/index.ts`'s `main()` boot path on
// module import (which would attempt to load config, run migrations,
// and probe the DB).
//
// 127.0.0.1 is defense-in-depth: Caddy on the production host reverse-
// proxies the public-facing TLS endpoints to 127.0.0.1:3000 (HTTP) and
// 127.0.0.1:3001 (tunnel WS); the firewall closes both ports to the
// public internet, but binding to localhost means a misconfigured
// firewall can't leak the engine upstream. e2e tests use random ports
// on 127.0.0.1 too (see tests/e2e/setup.ts), so this is a no-op for
// them.

export const ENGINE_LISTEN_HOSTNAME = "127.0.0.1" as const;

/** Listen options for any engine TCP listener — both
 *  `@hono/node-server`'s `serve()` and `startTunnelWsServer()`
 *  consume the same `{ port, hostname }` shape, so a single helper
 *  serves both. The HTTP listener and the tunnel WS listener used
 *  to have one helper each (`engineHttpServeOptions` /
 *  `engineTunnelServeOptions`); they were identical, so the round-7
 *  reviewer collapsed them. The single function reduces what the
 *  regression test in `apps/engine/src/http/tests/listen-hostname.test.ts`
 *  has to fence. */
export function engineServeOptions(port: number): { port: number; hostname: string } {
  return { port, hostname: ENGINE_LISTEN_HOSTNAME };
}
