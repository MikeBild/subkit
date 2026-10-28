import { isPlainRequestName } from "../../connectors/public-view.ts";
import { isLogSensitiveKey } from "../../logging/scrub-secrets.ts";

const MASK = /\*\*\*redacted(?::[a-z_]+)?\*\*\*/i;
const HEADER_MAP_KEYS: ReadonlySet<string> = new Set([
  "headers",
  "extra_headers",
  "static_headers",
  "default_headers",
  "extra_token_headers",
]);

export interface StrippedValue<T> {
  value: T;
  removed: string[];
}

export function carriesMask(value: unknown): boolean {
  if (typeof value === "string") return MASK.test(value);
  if (Array.isArray(value)) return value.some(carriesMask);
  if (value !== null && typeof value === "object") return Object.values(value).some(carriesMask);
  return false;
}

export function stripMaskedValues(
  value: Record<string, unknown>,
  path: string,
): StrippedValue<Record<string, unknown>> {
  const removed: string[] = [];
  const walk = (node: unknown, at: string): unknown => {
    if (typeof node === "string") {
      if (MASK.test(node)) {
        removed.push(at);
        return undefined;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((child, i) => walk(child, `${at}[${i}]`)).filter((v) => v !== undefined);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const next = walk(child, `${at}.${key}`);
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, path) as Record<string, unknown>, removed };
}

export function stripSecretFields(
  value: Record<string, unknown>,
  path: string,
): StrippedValue<Record<string, unknown>> {
  const removed: string[] = [];
  const walk = (node: unknown, at: string, headers: boolean): unknown => {
    if (typeof node === "string") {
      if (MASK.test(node)) {
        removed.push(at);
        return undefined;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node
        .map((child, i) => walk(child, `${at}[${i}]`, false))
        .filter((v) => v !== undefined);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const secret = headers ? !isPlainRequestName(key) : isLogSensitiveKey(key);
        if (secret && child !== null && child !== "") {
          removed.push(`${at}.${key}`);
          continue;
        }
        const next = walk(child, `${at}.${key}`, HEADER_MAP_KEYS.has(key));
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, path, false) as Record<string, unknown>, removed };
}

export function stripMaskedUrl(url: string | null, field: string): StrippedValue<string | null> {
  if (url === null) return { value: url, removed: [] };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASK.test(url) ? { value: null, removed: [field] } : { value: url, removed: [] };
  }
  if (!MASK.test(url) && parsed.username === "" && parsed.password === "") {
    return { value: url, removed: [] };
  }
  const removed: string[] = [];
  if (parsed.username !== "" || parsed.password !== "") {
    parsed.username = "";
    parsed.password = "";
    removed.push(`${field}.userinfo`);
  }
  for (const [name, value] of [...parsed.searchParams.entries()]) {
    if (MASK.test(value)) {
      parsed.searchParams.delete(name);
      removed.push(`${field}.query.${name}`);
    }
  }
  const rebuilt = parsed.toString();
  if (MASK.test(rebuilt) || MASK.test(decodeURIComponent(rebuilt)))
    return { value: null, removed: [field] };
  return { value: rebuilt, removed };
}
