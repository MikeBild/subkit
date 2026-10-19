import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import { getConfig } from "../config/loader.ts";
import type { AppEnv } from "./openapi.ts";

export function normalizeClientIp(value: string | undefined): string | undefined {
  if (!value || isIP(value) === 0) return undefined;
  if (isIP(value) === 4) return value;
  let canonical: string;
  try {
    canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] && mapped[2]) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}

export function resolveTrustedClientIp(options: {
  peer?: string | undefined;
  forwardedFor?: string | undefined;
  trustedHops: number;
  trustedProxyIps: string[];
}): string {
  const peer = normalizeClientIp(options.peer);
  if (!peer) return "unknown";
  const trusted = new Set(options.trustedProxyIps.map(normalizeClientIp).filter(Boolean));
  if (!Number.isInteger(options.trustedHops) || options.trustedHops < 1 || !trusted.has(peer)) {
    return peer;
  }
  const parts = options.forwardedFor?.split(",").map((part) => part.trim()) ?? [];
  if (parts.length < options.trustedHops) return peer;
  const suffix = parts.slice(-options.trustedHops).map(normalizeClientIp);
  const candidate = suffix[0];
  if (!candidate || suffix.slice(1).some((address) => !address || !trusted.has(address)))
    return peer;
  return candidate;
}

export function clientIpMiddleware(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    let trustedHops = 0;
    let trustedProxyIps: string[] = [];
    try {
      const server = getConfig().server;
      trustedHops = server.trusted_proxy_hops;
      trustedProxyIps = server.trusted_proxy_ips;
    } catch {}
    context.set(
      "client_ip",
      resolveTrustedClientIp({
        peer: context.env?.incoming?.socket.remoteAddress,
        forwardedFor: context.req.header("x-forwarded-for"),
        trustedHops,
        trustedProxyIps,
      }),
    );
    await next();
  };
}
