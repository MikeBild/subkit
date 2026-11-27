import type { TranslationKey } from "@/lib/i18n";

export type AddressTarget = "web" | "mcp";

const HOST_GATEWAYS = new Set(["host.docker.internal", "gateway.docker.internal"]);

function parsed(address: string): URL | null {
  const value = address.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackIpv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  if (HOST_GATEWAYS.has(host)) return true;
  return isLoopbackIpv4(host);
}

export function isLocalAddress(address: string): boolean {
  const url = parsed(address);
  return url !== null && isLocalHost(url.hostname);
}

export function isLocalHttpsAddress(address: string): boolean {
  const url = parsed(address);
  return url !== null && url.protocol === "https:" && isLocalHost(url.hostname);
}

export function addressProblem(address: string, target: AddressTarget): TranslationKey | null {
  const url = parsed(address);
  if (!url) return "create.connector.addressInvalid";
  if (isLocalHost(url.hostname)) return null;
  if (url.protocol !== "https:") return "create.connector.addressInvalid";
  if (target === "web" && !url.hostname.includes(".")) return "create.connector.addressInvalid";
  return null;
}
