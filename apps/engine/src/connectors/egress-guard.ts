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
// Per-tenant override: `tenants.egress_guard_mode` (added in 0041) lets
// an operator opt one tenant into `permissive` while the rest stay on
// the env-var default. Call sites that have a loaded `Tenant` row
// should pass `ctx.mode = tenant.egress_guard_mode ?? undefined` —
// the resolver below honors it ahead of the env-var fallback.

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import { getRobots } from "./robots-cache.ts";

export type EgressGuardMode = "strict" | "permissive";

export interface EgressGuardContext {
  tenant_id?: string;
  /** Explicit mode override. When unset, falls back to
   *  `getConfig().egress.mode`, then to the NODE_ENV default. */
  mode?: EgressGuardMode;
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

/** Thrown by `assertRobotsAllowed` when robots.txt disallows the path
 *  for the configured User-Agent. Caught by the HTTP driver and mapped
 *  to step error `code: "robots_disallowed"`. */
export class RobotsDisallowedError extends Error {
  readonly code = "robots_disallowed";
  constructor(
    public readonly url: string,
    public readonly userAgent: string,
  ) {
    super(`robots.txt disallows ${url} for user-agent ${userAgent}`);
    this.name = "RobotsDisallowedError";
  }
}

function resolveMode(ctx: EgressGuardContext): EgressGuardMode {
  if (ctx.mode === "strict" || ctx.mode === "permissive") return ctx.mode;
  try {
    const cfgMode = getConfig().egress.mode;
    if (cfgMode === "strict" || cfgMode === "permissive") return cfgMode;
  } catch {
    /* loader not initialised */
  }
  // v3.5: EGRESS_GUARD env retired — egress.mode is the canonical leaf.
  // Operators who still set the env var get a warn at boot via
  // RETIRED_ENV_KEYS. Final fallback is NODE_ENV-derived: production
  // defaults to strict, everything else to permissive.
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
 */
export function assertEgressAllowed(url: URL | string, ctx: EgressGuardContext): void {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const host = stripBrackets(parsed.hostname.toLowerCase());

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

/**
 * Web-scraper connector robots.txt enforcement. Throws
 * `RobotsDisallowedError` when robots.txt disallows the given URL for
 * the configured User-Agent. Per-tenant + TTL-cached via
 * `robots-cache.ts`. Pass `fetchImpl` to inject a stub from tests.
 *
 * Call sites:
 *   - `drivers/http.ts buildRequestPlan` invokes this when the
 *     connector template config has `respect_robots: true` OR the
 *     tenant overlay enables it. The default for the `web-scraper`
 *     template is true.
 *   - The `analyze_scrape_target` chat tool consults this during the
 *     authoring probe.
 */
export async function assertRobotsAllowed(
  url: URL | string,
  ctx: {
    tenant_id: string;
    userAgent: string;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const origin = parsed.origin;
  const robots = await getRobots({
    tenantId: ctx.tenant_id,
    origin,
    userAgent: ctx.userAgent,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (robots === null) return; // no robots.txt → allow
  const allowed = robots.isAllowed(parsed.toString(), ctx.userAgent);
  // robots-parser returns `undefined` when the file is malformed or the
  // path has no matching rule; per RFC 9309 §2.2.2 we treat that as
  // allow.
  if (allowed === false) {
    logger.warn({
      module: "egress_guard",
      action: "robots_disallowed",
      tenant_id: ctx.tenant_id,
      url: parsed.toString(),
      user_agent: ctx.userAgent,
    });
    throw new RobotsDisallowedError(parsed.toString(), ctx.userAgent);
  }
}
