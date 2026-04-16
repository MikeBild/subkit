// Response filters: KEYS / VALUES / BOTH x REMOVE / MASK / FAIL.
// Filters compose top-to-bottom. The body is mutated in-place when possible
// to avoid extra allocations on large pages.

import type { ResponseFilter } from "../workflows/types.ts";

export class ResponseFilterFailError extends Error {
  constructor(
    public readonly path: string,
    public readonly filter: ResponseFilter,
  ) {
    super(`response filter FAIL triggered at ${path}`);
    this.name = "ResponseFilterFailError";
  }
}

const DEFAULT_MASK = "***redacted***";

function matches(filter: ResponseFilter, key: string | null, value: unknown): boolean {
  const re = new RegExp(filter.pattern);
  if (filter.target === "KEYS" || filter.target === "BOTH") {
    if (key && re.test(key)) return true;
  }
  if (filter.target === "VALUES" || filter.target === "BOTH") {
    if (typeof value === "string" && re.test(value)) return true;
    if (typeof value === "number" && re.test(String(value))) return true;
  }
  return false;
}

function applyOne(filter: ResponseFilter, body: unknown, path = "$"): unknown {
  if (Array.isArray(body)) {
    return body
      .map((item, i) => applyOne(filter, item, `${path}[${i}]`))
      .filter((item) => item !== REMOVE_TOKEN);
  }
  if (body && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const here = `${path}.${k}`;
      if (matches(filter, k, v)) {
        if (filter.action === "FAIL") {
          throw new ResponseFilterFailError(here, filter);
        }
        if (filter.action === "REMOVE") {
          continue;
        }
        if (filter.action === "MASK") {
          out[k] = filter.mask ?? DEFAULT_MASK;
          continue;
        }
      }
      const recur = applyOne(filter, v, here);
      if (recur !== REMOVE_TOKEN) out[k] = recur;
    }
    return out;
  }
  // primitives: only the parent considered key/value matches
  return body;
}

const REMOVE_TOKEN = Symbol("remove");

export function applyResponseFilters(
  filters: ResponseFilter[] | undefined,
  body: unknown,
): unknown {
  if (!filters || filters.length === 0) return body;
  let out = body;
  for (const f of filters) {
    out = applyOne(f, out);
  }
  return out;
}
