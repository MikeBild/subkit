import type { AllowanceEnteredBy } from "../device/boundary.ts";
import { ALLOW, type PolicyResult, refuse } from "./result.ts";

export type AddressClass = "public" | "private" | "loopback" | "link_local" | "reserved";

export interface SiteAllowanceLike {
  readonly origin: string;
  readonly entered_by: AllowanceEnteredBy;
}

export interface NormalizedOrigin {
  readonly origin: string;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly default_port: boolean;
  readonly host_class: AddressClass;
}

function parseIPv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

function parseGroups(value: string): number[] | null {
  if (value === "") return [];
  const groups: number[] = [];
  for (const part of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIPv6(input: string): number[] | null {
  let value = input.toLowerCase();
  const tail: number[] = [];
  const lastColon = value.lastIndexOf(":");
  const tailText = value.slice(lastColon + 1);
  if (tailText.includes(".")) {
    const v4 = parseIPv4(tailText);
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    const prefix = value.slice(0, lastColon + 1);
    value = prefix.endsWith("::") ? prefix : prefix.slice(0, -1);
  }
  const gap = value.indexOf("::");
  if (gap < 0) {
    const groups = parseGroups(value);
    if (groups === null) return null;
    const all = [...groups, ...tail];
    return all.length === 8 ? all : null;
  }
  const head = parseGroups(value.slice(0, gap));
  const rest = parseGroups(value.slice(gap + 2));
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function v4(a: number, b: number, c: number): number {
  return ((a * 256 + b) * 256 + c) * 256;
}

function inRange(address: number, start: number, bits: number): boolean {
  return address >= start && address < start + 2 ** (32 - bits);
}

function classifyV4(address: number): AddressClass {
  if (inRange(address, v4(127, 0, 0), 8)) return "loopback";
  if (inRange(address, v4(169, 254, 0), 16)) return "link_local";
  if (
    inRange(address, v4(10, 0, 0), 8) ||
    inRange(address, v4(172, 16, 0), 12) ||
    inRange(address, v4(192, 168, 0), 16) ||
    inRange(address, v4(100, 64, 0), 10)
  ) {
    return "private";
  }
  if (
    inRange(address, v4(0, 0, 0), 8) ||
    inRange(address, v4(192, 0, 0), 24) ||
    inRange(address, v4(192, 0, 2), 24) ||
    inRange(address, v4(192, 88, 99), 24) ||
    inRange(address, v4(198, 18, 0), 15) ||
    inRange(address, v4(198, 51, 100), 24) ||
    inRange(address, v4(203, 0, 113), 24) ||
    inRange(address, v4(224, 0, 0), 3)
  ) {
    return "reserved";
  }
  return "public";
}

function embedded(high: number, low: number): AddressClass {
  return classifyV4(high * 65536 + low);
}

function zeros(groups: readonly number[], from: number, to: number): boolean {
  return groups.slice(from, to).every((group) => group === 0);
}

function classifyV6(g: readonly number[]): AddressClass {
  const at = (index: number): number => g[index] ?? 0;
  if (zeros(g, 0, 7) && at(7) === 1) return "loopback";
  if (zeros(g, 0, 5) && at(5) === 0xffff) return embedded(at(6), at(7));
  if (zeros(g, 0, 4) && at(4) === 0xffff && at(5) === 0) return embedded(at(6), at(7));
  if (zeros(g, 0, 6)) {
    const inner = embedded(at(6), at(7));
    return inner === "public" ? "reserved" : inner;
  }
  if (at(0) === 0x64 && at(1) === 0xff9b && zeros(g, 2, 6)) return embedded(at(6), at(7));
  if (at(0) === 0x64 && at(1) === 0xff9b && at(2) === 1) return "private";
  if ((at(0) & 0xffc0) === 0xfe80) return "link_local";
  if ((at(0) & 0xffc0) === 0xfec0 || (at(0) & 0xfe00) === 0xfc00) return "private";
  if (at(0) === 0x2002) return embedded(at(1), at(2));
  if (at(0) === 0x2001 && (at(1) === 0 || at(1) === 0xdb8)) return "reserved";
  if (at(0) === 0x2001 && ((at(1) & 0xfff0) === 0x10 || (at(1) & 0xfff0) === 0x20)) {
    return "reserved";
  }
  if (at(0) === 0x3fff && (at(1) & 0xf000) === 0) return "reserved";
  return (at(0) & 0xe000) === 0x2000 ? "public" : "reserved";
}

function bareAddress(value: string): string {
  const trimmed = value.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.replace(/%.*/, "");
}

export function isIpLiteral(value: string): boolean {
  const bare = bareAddress(value);
  return parseIPv4(bare) !== null || parseIPv6(bare) !== null;
}

export function classifyAddress(ip: string): AddressClass {
  const bare = bareAddress(ip);
  const address = parseIPv4(bare);
  if (address !== null) return classifyV4(address);
  const v6 = parseIPv6(bare);
  return v6 === null ? "reserved" : classifyV6(v6);
}

export const PRIVATE_HOST_SUFFIXES: readonly string[] = [
  ".local",
  ".home.arpa",
  ".internal",
  ".lan",
  ".intranet",
  ".corp",
  ".home",
];
export const RESERVED_HOST_SUFFIXES: readonly string[] = [
  ".arpa",
  ".invalid",
  ".test",
  ".example",
  ".onion",
];

export function classifyHost(host: string): AddressClass {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(name)) return classifyAddress(name);
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "private";
  if (RESERVED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "reserved";
  if (name === "") return "reserved";
  return name.includes(".") ? "public" : "private";
}

export function isPrivateClass(value: AddressClass): boolean {
  return value !== "public";
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function normalizeParsed(url: URL): NormalizedOrigin | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const scheme = url.protocol === "http:" ? "http" : "https";
  const defaultPort = url.port === "";
  const port = defaultPort ? (scheme === "http" ? 80 : 443) : Number(url.port);
  const host = url.hostname.replace(/\.$/, "");
  return {
    origin: defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`,
    scheme,
    host,
    port,
    default_port: defaultPort,
    host_class: classifyHost(host),
  };
}

export function normalizeOrigin(input: string): NormalizedOrigin | null {
  const url = parseUrl(input);
  return url === null ? null : normalizeParsed(url);
}

export function parseSiteEntry(input: string): NormalizedOrigin | null {
  const url = parseUrl(input);
  if (url === null || url.pathname !== "/" || /[?#]/.test(input)) return null;
  return normalizeParsed(url);
}

function findAllowance(
  origin: NormalizedOrigin,
  allowances: readonly SiteAllowanceLike[],
): SiteAllowanceLike | undefined {
  return allowances.find(
    (allowance) => normalizeOrigin(allowance.origin)?.origin === origin.origin,
  );
}

function checkOrigin(
  url: string,
  allowances: readonly SiteAllowanceLike[],
): PolicyResult & { readonly person?: boolean } {
  const origin = normalizeOrigin(url);
  if (origin === null) return refuse("origin_not_allowed");
  const match = findAllowance(origin, allowances);
  const person = match?.entered_by === "person";
  if (isPrivateClass(origin.host_class) && !person) return refuse("private_address");
  if (match === undefined) return refuse("origin_not_allowed");
  if (!origin.default_port && !person) return refuse("origin_not_allowed");
  return { ok: true, person };
}

export function originAllowed(url: string, allowances: readonly SiteAllowanceLike[]): PolicyResult {
  const checked = checkOrigin(url, allowances);
  return checked.ok ? ALLOW : checked;
}

export function connectionAllowed(
  url: string,
  resolvedIp: string,
  allowances: readonly SiteAllowanceLike[],
): PolicyResult {
  return resolvedAllowed(checkOrigin(url, allowances), resolvedIp);
}

type CheckedOrigin = PolicyResult & { readonly person?: boolean };

function resolvedAllowed(checked: CheckedOrigin, resolvedIp: string): PolicyResult {
  if (!checked.ok) return checked;
  if (!isPrivateClass(classifyAddress(resolvedIp)) || checked.person === true) return ALLOW;
  return refuse("private_address");
}

export interface PersonalSiteOptions {
  readonly entered_by_person: readonly string[];
}

function listed(origin: NormalizedOrigin, list: readonly string[]): boolean {
  return list.some((entry) => normalizeOrigin(entry)?.origin === origin.origin);
}

function checkPersonal(url: string, options: PersonalSiteOptions): CheckedOrigin {
  const origin = normalizeOrigin(url);
  if (origin === null) return refuse("origin_not_allowed");
  const person = listed(origin, options.entered_by_person);
  if (isPrivateClass(origin.host_class) && !person) return refuse("private_address");
  if (!origin.default_port && !person) return refuse("origin_not_allowed");
  return { ok: true, person };
}

export function originAllowedPersonal(url: string, options: PersonalSiteOptions): PolicyResult {
  const checked = checkPersonal(url, options);
  return checked.ok ? ALLOW : checked;
}

export function connectionAllowedPersonal(
  url: string,
  resolvedIp: string,
  options: PersonalSiteOptions,
): PolicyResult {
  return resolvedAllowed(checkPersonal(url, options), resolvedIp);
}
