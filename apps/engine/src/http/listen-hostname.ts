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
// 127.0.0.1 is the DEFAULT and is defense-in-depth: Caddy on the
// production host reverse-proxies the public-facing TLS endpoint to
// 127.0.0.1:3000; the firewall closes the port to the public internet,
// but binding to localhost means a misconfigured firewall can't leak
// the engine upstream. e2e tests use random ports on 127.0.0.1 too
// (see tests/e2e/setup.ts), so this is a no-op for them.
//
// `ENGINE_LISTEN_HOST` opts out of that default. It exists for one
// case: containerised runs. Docker's published-port mapping forwards
// to the container's external interface, so a loopback-only listener
// is unreachable from `-p 3000:3000`. The all-in-one image sets
// `ENGINE_LISTEN_HOST=0.0.0.0` (the container is the trust boundary;
// the host's port mapping + firewall gate exposure). Unset → the
// loopback default is preserved verbatim for the systemd/Caddy host.

export const DEFAULT_ENGINE_LISTEN_HOSTNAME = "127.0.0.1" as const;

/** Back-compat alias — the historical export name for the default. */
export const ENGINE_LISTEN_HOSTNAME = DEFAULT_ENGINE_LISTEN_HOSTNAME;

export function resolveListenHostname(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ENGINE_LISTEN_HOST?.trim();
  return override ? override : DEFAULT_ENGINE_LISTEN_HOSTNAME;
}

export function engineServeOptions(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): { port: number; hostname: string } {
  return { port, hostname: resolveListenHostname(env) };
}
