import type { DeviceRefusal } from "../device/protocol.ts";
import {
  connectionAllowed,
  connectionAllowedPersonal,
  normalizeOrigin,
  originAllowed,
  originAllowedPersonal,
  type PersonalSiteOptions,
  type SiteAllowanceLike,
} from "./addresses.ts";
import { classifySize, isExecutable, isSecretFile } from "./paths.ts";
import { ALLOW, type PolicyResult, refuse } from "./result.ts";

export type ProxySiteRules =
  | { readonly mode: "personal"; readonly options: PersonalSiteOptions }
  | { readonly mode: "workflow"; readonly sites: readonly SiteAllowanceLike[] }
  | { readonly mode: "closed" };

export type SiteMode = "personal" | "workflow" | "outside_boundary";

export function siteModeFor(
  executionId: string | null,
  boundarySites: readonly unknown[] | undefined,
): SiteMode {
  if (executionId === null) return "personal";
  return boundarySites === undefined ? "outside_boundary" : "workflow";
}

export const CLOSED_RULES: ProxySiteRules = Object.freeze({ mode: "closed" });

export interface ProxyTarget {
  readonly url: string;
  readonly origin: string;
  readonly host: string;
  readonly port: number;
}

export type AddressChoice =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly code: DeviceRefusal | "unresolved" };

export const PROXY_USER = "subkit";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const WEBSOCKET_SCHEMES: Readonly<Record<string, string>> = Object.freeze({
  "ws:": "http:",
  "wss:": "https:",
});

export const EXECUTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-apple-diskimage",
  "application/vnd.apple.installer+xml",
  "application/x-sh",
  "application/x-csh",
  "application/java-archive",
  "application/x-java-jnlp-file",
]);

function toTarget(url: URL): ProxyTarget | null {
  const origin = normalizeOrigin(url.href);
  if (origin === null) return null;
  return {
    url: `${origin.origin}${url.pathname}${url.search}`,
    origin: origin.origin,
    host: origin.host,
    port: origin.port,
  };
}

function parse(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function requestTarget(raw: string): ProxyTarget | null {
  const url = parse(raw);
  if (url === null) return null;
  url.protocol = WEBSOCKET_SCHEMES[url.protocol] ?? url.protocol;
  return toTarget(url);
}

export function connectTarget(authority: string): ProxyTarget | null {
  const match = /^([^\s/?#@\\]+):([0-9]{1,5})$/.exec(authority);
  if (match === null) return null;
  const port = Number(match[2]);
  if (port < 1) return null;
  const url = parse(`${port === 80 ? "http" : "https"}://${match[1]}:${port}/`);
  return url === null ? null : toTarget(url);
}

export function connectCandidates(authority: string): ProxyTarget[] {
  const primary = connectTarget(authority);
  if (primary === null) return [];
  if (primary.port === 443) return [primary];
  return [primary, requestTarget(`http://${primary.host}:${primary.port}/`) as ProxyTarget];
}

export function chooseConnectTarget(authority: string, rules: ProxySiteRules): ProxyTarget | null {
  const candidates = connectCandidates(authority);
  return (
    candidates.find((candidate) => targetAllowed(candidate, rules).ok) ?? candidates[0] ?? null
  );
}

export function targetAllowed(target: ProxyTarget, rules: ProxySiteRules): PolicyResult {
  if (rules.mode === "personal") return originAllowedPersonal(target.url, rules.options);
  if (rules.mode === "workflow") return originAllowed(target.url, rules.sites);
  return refuse("origin_not_allowed");
}

function addressAllowed(target: ProxyTarget, address: string, rules: ProxySiteRules) {
  if (rules.mode === "personal")
    return connectionAllowedPersonal(target.url, address, rules.options);
  if (rules.mode === "workflow") return connectionAllowed(target.url, address, rules.sites);
  return refuse("origin_not_allowed");
}

export function pickAddress(
  target: ProxyTarget,
  addresses: readonly string[],
  rules: ProxySiteRules,
): AddressChoice {
  const first = addresses[0];
  if (first === undefined) return { ok: false, code: "unresolved" };
  for (const address of addresses) {
    const result = addressAllowed(target, address, rules);
    if (!result.ok) return result;
  }
  return { ok: true, address: first };
}

export function redirectAllowed(
  from: string,
  status: number,
  location: string | undefined,
  rules: ProxySiteRules,
): PolicyResult {
  if (!REDIRECT_STATUSES.has(status) || location === undefined) return ALLOW;
  const target = requestTarget(String(resolveRedirect(from, location)));
  return target === null ? refuse("origin_not_allowed") : targetAllowed(target, rules);
}

export function resolveRedirect(from: string, location: string): string | null {
  try {
    return new URL(location, from).href;
  } catch {
    return null;
  }
}

function decodeBase64(value: string): string | null {
  try {
    return atob(value);
  } catch {
    return null;
  }
}

export function proxyCredentials(header: string | undefined): string | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(String(header).trim());
  if (match === null) return null;
  const decoded = decodeBase64(match[1] as string);
  if (decoded === null) return null;
  const prefix = `${PROXY_USER}:`;
  return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : null;
}

export function proxyUrl(port: number, secret: string): string {
  return `http://${PROXY_USER}:${encodeURIComponent(secret)}@127.0.0.1:${port}`;
}

export function refusalStatus(code: DeviceRefusal | "unresolved"): number {
  return code === "unresolved" ? 502 : 403;
}

export interface DownloadCandidate {
  readonly name: string;
  readonly size: number;
  readonly mime: string | null;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function downloadAllowed(candidate: DownloadCandidate): PolicyResult {
  const name = candidate.name;
  if (name === "" || name.length > 255 || /[/\\]/.test(name) || hasControl(name)) {
    return refuse("outside_allowance");
  }
  if (name.startsWith(".")) return refuse("hidden_path");
  if (isSecretFile(name)) return refuse("secret_file");
  const mime = String(candidate.mime).replace(/;.*/s, "").trim().toLowerCase();
  if (isExecutable(name, null) || EXECUTABLE_MIME_TYPES.has(mime)) return refuse("executable");
  return classifySize("download_bytes", candidate.size);
}
