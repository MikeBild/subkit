import { isIP } from "node:net";

export type LocalTargetClass = "loopback" | "host_gateway";

export interface LocalTls {
  ca_pem?: string;
  skip_verify?: boolean;
}

export interface LocalMcpScope {
  origin: string;
  tls?: LocalTls;
}

const HOST_GATEWAY_NAMES = new Set(["host.docker.internal", "gateway.docker.internal"]);

function bareHost(hostname: string): string {
  let host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

export function isLoopbackAddress(address: string): boolean {
  const host = bareHost(address);
  if (host === "::1") return true;
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)?.[1];
  const ipv4 = mapped ?? host;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

export function classifyLocalHost(hostname: string): LocalTargetClass | null {
  const host = bareHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (isLoopbackAddress(host)) return "loopback";
  if (HOST_GATEWAY_NAMES.has(host)) return "host_gateway";
  return null;
}

export function classifyLocalTarget(url: URL | string): LocalTargetClass | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  if (!LOCAL_PROTOCOLS.has(parsed.protocol)) return null;
  return classifyLocalHost(parsed.hostname);
}

const LOCAL_PROTOCOLS = new Set(["http:", "https:", "postgres:", "postgresql:", "sftp:", "ssh:"]);

function tlsFrom(raw: unknown): LocalTls | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as { ca_pem?: unknown; skip_verify?: unknown };
  const tls: LocalTls = {};
  if (typeof value.ca_pem === "string" && value.ca_pem.length > 0) tls.ca_pem = value.ca_pem;
  if (value.skip_verify === true) tls.skip_verify = true;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

export function connectorLocalScope(connector: {
  base_url?: string | null;
  config?: unknown;
}): LocalMcpScope | undefined {
  const config =
    connector.config && typeof connector.config === "object"
      ? (connector.config as { tls?: unknown; mcp?: { tls?: unknown } })
      : {};
  return localMcpScopeFor(connector.base_url, tlsFrom(config.mcp?.tls ?? config.tls));
}

export function ownTargetScope(target: URL): LocalMcpScope | undefined {
  return classifyLocalTarget(target) === null ? undefined : { origin: target.href };
}

export function localMcpScopeFor(
  baseUrl: string | null | undefined,
  tls?: LocalTls,
): LocalMcpScope | undefined {
  if (!baseUrl || classifyLocalTarget(baseUrl) === null) return undefined;
  return { origin: new URL(baseUrl).href, ...(tls ? { tls } : {}) };
}

export function localTargetMatchesScope(target: URL, scope: LocalMcpScope): boolean {
  const targetClass = classifyLocalTarget(target);
  if (targetClass === null) return false;
  return targetClass === classifyLocalTarget(scope.origin);
}

export function resolvedAddressFitsLocalClass(
  address: string,
  targetClass: LocalTargetClass,
): boolean {
  if (targetClass === "loopback") return isLoopbackAddress(address);
  return true;
}

export function localTlsOptions(
  target: URL,
  scope: LocalMcpScope | undefined,
): { ca?: string; rejectUnauthorized?: boolean } | null {
  if (!scope?.tls || target.protocol !== "https:") return null;
  if (!localTargetMatchesScope(target, scope)) return null;
  const options: { ca?: string; rejectUnauthorized?: boolean } = {};
  if (scope.tls.ca_pem) options.ca = scope.tls.ca_pem;
  if (scope.tls.skip_verify === true) options.rejectUnauthorized = false;
  return Object.keys(options).length > 0 ? options : null;
}

export function ownTargetEntry(target: URL | string): { local_mcp?: LocalMcpScope } {
  let parsed: URL;
  try {
    parsed = typeof target === "string" ? new URL(target) : target;
  } catch {
    return {};
  }
  const scope = ownTargetScope(parsed);
  return scope ? { local_mcp: scope } : {};
}
