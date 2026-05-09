// Listen-hostname helpers — single source of truth for the bind
// interface the engine HTTP listener targets.
//
// Lives in its own leaf module (no side effects on import) so the
// regression test in apps/engine/src/http/tests/listen-hostname.test.ts
// can assert against the EXACT shape the runtime calls — without
// triggering `apps/engine/src/index.ts`'s `main()` boot path on
// module import (which would attempt to load config, run migrations,
// and probe the DB).
//
// 127.0.0.1 is defense-in-depth: Caddy on the production host reverse-
// proxies the public-facing TLS endpoint to 127.0.0.1:3000; the
// firewall closes the port to the public internet, but binding to
// localhost means a misconfigured firewall can't leak the engine
// upstream. e2e tests use random ports on 127.0.0.1 too (see
// tests/e2e/setup.ts), so this is a no-op for them.

export const ENGINE_LISTEN_HOSTNAME = "127.0.0.1" as const;

export function engineServeOptions(port: number): { port: number; hostname: string } {
  return { port, hostname: ENGINE_LISTEN_HOSTNAME };
}
