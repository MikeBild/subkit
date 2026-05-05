// SSRF egress guard for outbound HTTP from connectors, GraphQL, and
// webhook deliveries. Inspired by RFC 1918, RFC 3927 (link-local),
// RFC 4193 (unique-local IPv6), RFC 5735 (loopback), and the pragmatic
// blocklist used by hardened SaaS gateways post-CVE-2018-1002105 era.
//
// Why this lives in `connectors/`: every outbound call ultimately lands
// in `drivers/http.ts`, `drivers/graphql.ts`, or the webhook deliver
// worker. The same blocklist applies to all three. Pulling it out as
// `assertEgressAllowed` keeps the policy in one place.
//
// Tunnel exemption: when an outbound call is going through a tenant's
// registered tunnel (the tunnel IS the operator-authorized path to
// private networks), the guard is a no-op. Without this, every tunnel
// call would be blocked because tunnels are precisely how subkit
// reaches `10.x` / `192.168.x` services without exposing them publicly.
//
// Per-tenant override: `tenants.egress_guard_mode` (added in 0041) lets
// an operator opt one tenant into `permissive` while the rest stay on
// the env-var default. Call sites that have a loaded `Tenant` row
// should pass `ctx.mode = tenant.egress_guard_mode ?? undefined` —
// the resolver below honors it ahead of the env-var fallback.

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";

export type EgressGuardMode = "strict" | "permissive";

export interface EgressGuardContext {
  tenant_id?: string;
  /** Explicit mode override. When unset, falls back to
   *  `process.env.EGRESS_GUARD`, then to the NODE_ENV default. */
  mode?: EgressGuardMode;
  /** When set (non-empty), the guard is skipped entirely — the tunnel
   *  is the operator-authorized path to private networks. Pass `null`
   *  or `undefined` for direct egress (the common case). */
  tunnel_target?: string | null;
}

export class EgressBlockedError extends Error {
  readonly code = "egress_blocked";
  constructor(
    public readonly reason: string,
    public readonly host: string,
  ) {
    super(`${reason}: ${host}`);
    this.name = "EgressBlockedError";
  }
}

function resolveMode(ctx: EgressGuardContext): EgressGuardMode {
  if (ctx.mode === "strict" || ctx.mode === "permissive") return ctx.mode;
  try {
    const cfgMode = getConfig().egress.mode;
    if (cfgMode === "strict" || cfgMode === "permissive") return cfgMode;
  } catch {
    /* loader not initialised — fall through to NODE_ENV default */
  }
  return (process.env.NODE_ENV ?? "").toLowerCase() === "production" ? "strict" : "permissive";
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Resolve IPv4-mapped IPv6 (`::ffff:HHHH:HHHH` or `::ffff:d.d.d.d`) to
 * the dotted-quad IPv4 it represents. Node's URL parser normalises
 * `::ffff:10.0.0.1` to `::ffff:a00:1` (hex form), so we have to handle
 * both. Returns `null` if `host` is not an IPv4-mapped IPv6.
 */
function ipv4MappedToIPv4(host: string): string | null {
  const decimal = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (decimal?.[1]) return decimal[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

/**
 * Returns true when `hostname` resolves to a loopback, RFC 1918,
 * link-local, IPv6 unique-local, IPv4-mapped private, or otherwise
 * blocked target. Pure check — does not throw.
 */
export function isPrivateOrLoopback(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase());

  // Bare hostnames that should never escape the host machine.
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;

  // Resolve IPv4-mapped IPv6 first so IPv4 ranges below catch them too.
  const mapped = ipv4MappedToIPv4(host);
  const ipv4Host = mapped ?? host;

  // Unspecified addresses.
  if (ipv4Host === "0.0.0.0") return true;
  if (host === "::" || host === "::0") return true;

  // Loopback — full /8, not just 127.0.0.1.
  if (host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;

  // RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;

  // Link-local IPv4: 169.254.0.0/16 (covers AWS EC2 metadata 169.254.169.254).
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;

  // IPv6 unique-local (fc00::/7 → fc..–fd..) and link-local (fe80::/10).
  if (host.includes(":")) {
    const m = host.match(/^([0-9a-f]{1,4})(?::|$)/i);
    if (m?.[1]) {
      const firstHextet = parseInt(m[1], 16);
      // fe80::/10 — top 10 bits match 0xFE80, mask 0xFFC0.
      if ((firstHextet & 0xffc0) === 0xfe80) return true;
      // fc00::/7 — top 7 bits match 0xFC00, mask 0xFE00 (covers fc..–fd..).
      if ((firstHextet & 0xfe00) === 0xfc00) return true;
    }
  }

  return false;
}

/**
 * Throw `EgressBlockedError` when `url` targets a private/internal
 * host under the current mode. In `permissive` mode only the most
 * obvious offenders (`localhost`, `0.0.0.0`) are blocked, so the
 * gate is non-trivial in development.
 *
 * When `ctx.tunnel_target` is set (non-empty), the check is skipped
 * entirely — the tunnel itself is the operator-authorized path into
 * the private network.
 */
export function assertEgressAllowed(url: URL | string, ctx: EgressGuardContext): void {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const host = stripBrackets(parsed.hostname.toLowerCase());

  if (typeof ctx.tunnel_target === "string" && ctx.tunnel_target.length > 0) {
    logger.debug({
      module: "egress_guard",
      action: "tunnel_exempt",
      tunnel_target: ctx.tunnel_target,
      tenant_id: ctx.tenant_id ?? null,
      host,
    });
    return;
  }

  const mode = resolveMode(ctx);

  if (mode === "permissive") {
    // Keep the gate non-trivial: even in permissive mode, an unspecified
    // address or a bare `localhost` is almost always a misconfiguration.
    if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::0") {
      logger.warn({
        module: "egress_guard",
        action: "blocked",
        reason: "private_ip_blocked",
        host,
        mode,
        tenant_id: ctx.tenant_id ?? null,
      });
      throw new EgressBlockedError("private_ip_blocked", host);
    }
    return;
  }

  if (isPrivateOrLoopback(host)) {
    logger.warn({
      module: "egress_guard",
      action: "blocked",
      reason: "private_ip_blocked",
      host,
      mode,
      tenant_id: ctx.tenant_id ?? null,
    });
    throw new EgressBlockedError("private_ip_blocked", host);
  }
}
