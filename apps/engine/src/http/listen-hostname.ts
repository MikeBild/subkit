import { type EnvRecord, envSnapshot } from "../env.ts";
export const DEFAULT_ENGINE_LISTEN_HOSTNAME = "127.0.0.1" as const;

export const ENGINE_LISTEN_HOSTNAME = DEFAULT_ENGINE_LISTEN_HOSTNAME;

function isValidListenHost(host: string): boolean {
  if (host.includes(":")) return /^[0-9a-fA-F:]+$/.test(host);
  return host.split(".").every((label) => /^[A-Za-z0-9-]+$/.test(label));
}

export function resolveListenHostname(env: EnvRecord = envSnapshot()): string {
  const override = env.ENGINE_LISTEN_HOST?.trim();
  if (!override) return DEFAULT_ENGINE_LISTEN_HOSTNAME;
  if (!isValidListenHost(override)) {
    throw new Error(
      `ENGINE_LISTEN_HOST="${override}" is not a valid bind host — ` +
        `expected an IPv4/IPv6 address or hostname. Unset it to use the ` +
        `${DEFAULT_ENGINE_LISTEN_HOSTNAME} default, or set 0.0.0.0 for all interfaces.`,
    );
  }
  return override;
}

export function engineServeOptions(
  port: number,
  env: EnvRecord = envSnapshot(),
  loopbackOnly = false,
): { port: number; hostname: string } {
  return {
    port,
    hostname: loopbackOnly ? DEFAULT_ENGINE_LISTEN_HOSTNAME : resolveListenHostname(env),
  };
}
