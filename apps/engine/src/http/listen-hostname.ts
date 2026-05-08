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
 *  `@hono/node-server`'s `serve()` (HTTP request ingress) and
 *  `startTunnelWsServer()` (tunnel-agent WS ingress) consume the
 *  same `{ port, hostname }` shape, so one helper serves both.
 *
 *  Two listener semantics, ONE default today:
 *    - HTTP ingress (port 3000) → Caddy reverse-proxies the
 *      public TLS endpoint to 127.0.0.1:3000.
 *    - Tunnel WS ingress (port 3001) → Caddy reverse-proxies
 *      wss://subkit-tunnel.* to 127.0.0.1:3001 and tunnel agents
 *      dial outbound from a private network.
 *
 *  Both default to 127.0.0.1 because Caddy on the same host fronts
 *  both — defense-in-depth: a misconfigured firewall can't leak
 *  either upstream. A future deployment that fronts the *tunnel*
 *  with a separate proxy (load-balanced cluster, dedicated WSS
 *  endpoint, multi-host setup) will need to opt out by passing an
 *  explicit `hostname` argument; at that point the right
 *  refactor is to split this back into `engineHttpServeOptions` /
 *  `engineTunnelServeOptions`. The collapse to one helper is a
 *  current-deployment optimisation, not a contract. */
export function engineServeOptions(port: number): { port: number; hostname: string } {
  return { port, hostname: ENGINE_LISTEN_HOSTNAME };
}
