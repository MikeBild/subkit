export const ALLOWED_HOST_RULE =
  "must be a list of 1 to 50 host names such as docs.example.com, without scheme, port, path, wildcard or IP address";
export const MAX_ALLOWED_HOSTS = 50;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN = /[\s:/\\@?#[\]%*]/;

export function canonicalHostname(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return null;
  if (FORBIDDEN.test(value) || value.endsWith(".")) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${value}/`).hostname;
  } catch {
    return null;
  }
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  return /^[0-9]+$/.test(labels[labels.length - 1] ?? "") ? null : hostname;
}

export function canonicalHostList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALLOWED_HOSTS) return null;
  const hosts = value.map(canonicalHostname);
  if (hosts.some((host) => host === null)) return null;
  return [...new Set(hosts as string[])].sort();
}

export type DestinationHostIssue = "scheme" | "userinfo" | "port" | "host";

export function destinationHostIssue(
  hosts: readonly string[],
  url: URL,
): DestinationHostIssue | null {
  if (url.protocol !== "https:") return "scheme";
  if (url.username || url.password) return "userinfo";
  if (url.port !== "") return "port";
  return hosts.includes(url.hostname) ? null : "host";
}
