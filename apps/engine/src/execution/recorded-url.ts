import { scrubUrl } from "../connectors/egress.ts";

const ADDRESS_KEYS: ReadonlySet<string> = new Set(["url", "resolved_url"]);

function scrubAddress(value: string): string {
  try {
    new URL(value);
  } catch {
    return value.split("?")[0] ?? "";
  }
  return scrubUrl(value);
}

export function scrubRecordedUrls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubRecordedUrls) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    out[key] =
      ADDRESS_KEYS.has(key) && typeof entry === "string"
        ? scrubAddress(entry)
        : scrubRecordedUrls(entry);
  return out as T;
}
