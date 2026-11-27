import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { readEnv } from "../env.ts";
import { logger } from "../logging/index.ts";
import {
  classifyLocalTarget,
  type LocalMcpScope,
  localTargetMatchesScope,
  resolvedAddressFitsLocalClass,
} from "./local-egress.ts";
import { getRobotsVerification } from "./robots-cache.ts";

export type EgressGuardMode = "strict" | "permissive";

export type EgressLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const lookupOverrides = new AsyncLocalStorage<EgressLookup>();
type TenantOriginReader = (tenantId: string) => Promise<"self_service" | "self_hosted" | null>;
const tenantOriginOverrides = new AsyncLocalStorage<TenantOriginReader>();

export function _withEgressTenantOriginForTests<T>(
  reader: TenantOriginReader,
  run: () => Promise<T>,
): Promise<T> {
  return tenantOriginOverrides.run(reader, run);
}

async function readTenantOrigin(
  tenantId: string,
  exec: Executor,
): Promise<"self_service" | "self_hosted"> {
  try {
    const readOrigin = tenantOriginOverrides.getStore();
    const origin = readOrigin
      ? await readOrigin(tenantId)
      : (await (await import("../identity/service.ts")).getTenant(tenantId, exec))?.origin;
    if (!origin) throw new EgressBlockedError("tenant_context_unavailable", "");
    return origin;
  } catch (error) {
    if (error instanceof EgressBlockedError) throw error;
    throw new EgressBlockedError("tenant_context_unavailable", "");
  }
}

function localServersAllowed(): boolean {
  try {
    return getConfig().connectors.local_servers !== "deny";
  } catch (error) {
    logger.debug({
      module: "egress_guard",
      action: "local_servers_setting_unavailable",
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export async function resolveTenantEgressContext(
  context: EgressGuardContext,
): Promise<EgressGuardContext> {
  if (context.local_mcp_granted !== undefined) return context;
  if (context.local_mcp && context.tenant_id && localServersAllowed()) {
    const origin = await readTenantOrigin(context.tenant_id, context.exec).catch(
      (error: unknown) => {
        logger.warn({
          module: "egress_guard",
          action: "local_target_origin_unavailable",
          tenant_id: context.tenant_id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      },
    );
    if (origin === "self_hosted") return { ...context, local_mcp_granted: true };
  }
  const resolved: EgressGuardContext = context.local_mcp
    ? { ...context, local_mcp_granted: false }
    : context;
  if (!resolved.tenant_id || resolveEgressGuardMode(resolved) === "strict") return resolved;
  const origin = await readTenantOrigin(resolved.tenant_id, resolved.exec);
  return origin === "self_service" ? { ...resolved, mode: "strict" } : resolved;
}

export function _withEgressLookupForTests<T>(
  lookupImpl: EgressLookup,
  run: () => Promise<T>,
): Promise<T> {
  return lookupOverrides.run(lookupImpl, run);
}

export type EgressTenantScope =
  | { tenant_id: string; exec: Executor }
  | { tenant_id?: undefined; exec?: undefined };

export type EgressGuardContext = EgressTenantScope & {
  mode?: EgressGuardMode;
  local_mcp?: LocalMcpScope;
  local_mcp_granted?: boolean;
};

export function grantedLocalTarget(url: URL, ctx: EgressGuardContext): boolean {
  return (
    ctx.local_mcp_granted === true &&
    ctx.local_mcp !== undefined &&
    localTargetMatchesScope(url, ctx.local_mcp)
  );
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

class RobotsVerificationUnavailableError extends Error {
  readonly code = "robots_verification_unavailable";
  constructor() {
    super("robots.txt verification is unavailable; retry before requesting this resource");
    this.name = "RobotsVerificationUnavailableError";
  }
}

export function resolveEgressGuardMode(ctx: EgressGuardContext): EgressGuardMode {
  if (ctx.mode === "strict" || ctx.mode === "permissive") return ctx.mode;
  try {
    const cfgMode = getConfig().egress.mode;
    if (cfgMode === "strict" || cfgMode === "permissive") return cfgMode;
  } catch {}
  return (readEnv("NODE_ENV") ?? "").toLowerCase() === "production" ? "strict" : "permissive";
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

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

function embeddedIpv4ToIPv4(host: string): string | null {
  const translated = host.match(/^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const embedded = host.match(/^(?:::|64:ff9b::)(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/i);
  const highPart = translated?.[1] ?? embedded?.[1] ?? "0";
  const lowPart = translated?.[2] ?? embedded?.[2];
  if (!lowPart) return null;
  const high = parseInt(highPart, 16);
  const low = parseInt(lowPart, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

export function isPrivateOrLoopback(hostname: string): boolean {
  let host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, "");
  if (isIP(host) === 6) host = stripBrackets(new URL(`http://[${host}]`).hostname);

  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;

  const mapped = ipv4MappedToIPv4(host);
  const embedded = mapped ? null : embeddedIpv4ToIPv4(host);
  const ipv4Host = mapped ?? embedded ?? host;

  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (host === "::" || host === "::0") return true;

  if (host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;

  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ipv4Host)) return true;
  if (isIP(ipv4Host) === 4) {
    const [first, second] = ipv4Host.split(".").map(Number);
    if (first === 100 && second !== undefined && second >= 64 && second <= 127) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first !== undefined && first >= 224) return true;
  }

  if (host.includes(":")) {
    if (host.startsWith("64:ff9b:1:")) return true;
    if (host.startsWith("2002:")) return true;
    if (/^2001:(?:0{1,4}:|:)/.test(host)) return true;
    const m = host.match(/^([0-9a-f]{1,4})(?::|$)/i);
    if (m?.[1]) {
      const firstHextet = parseInt(m[1], 16);
      if ((firstHextet & 0xffc0) === 0xfe80) return true;
      if ((firstHextet & 0xfe00) === 0xfc00) return true;
      if ((firstHextet & 0xffc0) === 0xfec0) return true;
      if ((firstHextet & 0xff00) === 0xff00) return true;
    }
  }

  return false;
}

export function assertEgressAllowed(url: URL | string, ctx: EgressGuardContext): void {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const host = stripBrackets(parsed.hostname.toLowerCase());

  const mode = resolveEgressGuardMode(ctx);

  if (grantedLocalTarget(parsed, ctx)) {
    logger.info({
      module: "egress_guard",
      action: "local_mcp_allowed",
      host,
      mode,
      tenant_id: ctx.tenant_id ?? null,
    });
    return;
  }

  if (ctx.local_mcp_granted === true && classifyLocalTarget(parsed) !== null) {
    throw new EgressBlockedError("local_target_outside_connector", host);
  }

  if (mode === "permissive") {
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

export async function resolveAllowedEgressAddresses(
  url: URL | string,
  ctx: EgressGuardContext,
  deps: { lookupImpl?: EgressLookup } = {},
): Promise<Array<{ address: string; family: number }>> {
  ctx = await resolveTenantEgressContext(ctx);
  const parsed = typeof url === "string" ? new URL(url) : url;
  assertEgressAllowed(parsed, ctx);

  const localClass = grantedLocalTarget(parsed, ctx) ? classifyLocalTarget(parsed) : null;

  if (resolveEgressGuardMode(ctx) === "permissive") return [];

  const host = stripBrackets(parsed.hostname.toLowerCase());
  if (localClass !== null) {
    if (isIP(host) !== 0) return [{ address: host, family: isIP(host) }];
    const resolveLocal: EgressLookup =
      deps.lookupImpl ??
      lookupOverrides.getStore() ??
      ((hostname, options) => lookup(hostname, options));
    let localAddrs: Array<{ address: string; family: number }>;
    try {
      localAddrs = await resolveLocal(host, { all: true });
    } catch {
      throw new EgressBlockedError("dns_resolution_failed", host);
    }
    if (localAddrs.length === 0) throw new EgressBlockedError("dns_resolution_failed", host);
    for (const { address, family } of localAddrs) {
      if (isIP(address) === 0 || isIP(address) !== family)
        throw new EgressBlockedError("dns_resolution_failed", host);
      if (!resolvedAddressFitsLocalClass(address, localClass))
        throw new EgressBlockedError("local_name_resolved_elsewhere", host);
    }
    return localAddrs;
  }
  if (isIP(host) !== 0) return [{ address: host, family: isIP(host) }];

  const lookupImpl: EgressLookup =
    deps.lookupImpl ??
    lookupOverrides.getStore() ??
    ((hostname, options) => lookup(hostname, options));
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupImpl(host, { all: true });
  } catch {
    throw new EgressBlockedError("dns_resolution_failed", host);
  }
  if (addrs.length === 0) throw new EgressBlockedError("dns_resolution_failed", host);
  for (const { address, family } of addrs) {
    if (isIP(address) === 0 || isIP(address) !== family)
      throw new EgressBlockedError("dns_resolution_failed", host);
    if (isPrivateOrLoopback(address)) {
      logger.warn({
        module: "egress_guard",
        action: "blocked",
        reason: "private_ip_resolved",
        host,
        resolved: address,
        tenant_id: ctx.tenant_id ?? null,
      });
      throw new EgressBlockedError("private_ip_resolved", host);
    }
  }
  return addrs;
}

export async function assertEgressAllowedResolved(
  url: URL | string,
  ctx: EgressGuardContext,
  deps: { lookupImpl?: EgressLookup } = {},
): Promise<void> {
  await resolveAllowedEgressAddresses(url, ctx, deps);
}

export async function assertRobotsAllowed(
  url: URL | string,
  ctx: {
    tenant_id: string;
    exec: Executor;
    userAgent: string;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const origin = parsed.origin;
  const verification = await getRobotsVerification({
    tenantId: ctx.tenant_id,
    exec: ctx.exec,
    origin,
    userAgent: ctx.userAgent,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (verification.status === "unavailable") throw new RobotsVerificationUnavailableError();
  if (verification.parsed === null) return;
  const allowed = verification.parsed.isAllowed(parsed.toString(), ctx.userAgent);
  if (allowed === false) {
    logger.warn({
      module: "egress_guard",
      action: "robots_disallowed",
      tenant_id: ctx.tenant_id,
      url: `${parsed.origin}${parsed.pathname}`,
      user_agent: ctx.userAgent,
    });
    throw new RobotsDisallowedError(`${parsed.origin}${parsed.pathname}`, ctx.userAgent);
  }
}
