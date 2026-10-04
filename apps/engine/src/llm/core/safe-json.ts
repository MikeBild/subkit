import { jsonrepair } from "jsonrepair";

export function safeParseJson<T = unknown>(raw: string): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(raw)) as T;
    } catch {
      return undefined;
    }
  }
}

export function safeParseJsonWithMeta<T = unknown>(
  raw: string,
): { ok: true; value: T; repaired: boolean } | { ok: false } {
  if (!raw) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) as T, repaired: false };
  } catch {
    try {
      return { ok: true, value: JSON.parse(jsonrepair(raw)) as T, repaired: true };
    } catch {
      return { ok: false };
    }
  }
}
