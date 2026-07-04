// Response filters: KEYS / VALUES / BOTH x REMOVE / MASK / FAIL.
// Filters compose top-to-bottom. The body is mutated in-place when possible
// to avoid extra allocations on large pages.
//
// Scope widens the blast radius of a match:
//   FIELD  — the default; only the matched key/value is affected.
//   ITEM   — when any descendant matches, the *containing object* is
//            removed / masked / failed. The match still has to happen
//            inside that object (or its children).
//   ENTRY  — when any descendant matches, the *top-level array element*
//            that transitively contains the match is removed / masked /
//            failed. Matches inside a non-array root fall back to ITEM
//            semantics so the scope is still coherent.

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

/**
 * Does this subtree contain any matching key/value pair? Used by ITEM
 * and ENTRY scopes to decide whether the containing object/element
 * should be struck whole, without mutating its contents.
 */
function subtreeMatches(filter: ResponseFilter, node: unknown): boolean {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (subtreeMatches(filter, item)) return true;
    }
    return false;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (matches(filter, k, v)) return true;
      if (subtreeMatches(filter, v)) return true;
    }
    return false;
  }
  return false;
}

const REMOVE_TOKEN = Symbol("remove");

function strikeWhole(filter: ResponseFilter, path: string): unknown {
  if (filter.action === "FAIL") {
    throw new ResponseFilterFailError(path, filter);
  }
  if (filter.action === "REMOVE") return REMOVE_TOKEN;
  if (filter.action === "MASK") return filter.mask ?? DEFAULT_MASK;
  return REMOVE_TOKEN;
}

function applyFieldScope(filter: ResponseFilter, body: unknown, path = "$"): unknown {
  if (Array.isArray(body)) {
    return body
      .map((item, i) => applyFieldScope(filter, item, `${path}[${i}]`))
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
      const recur = applyFieldScope(filter, v, here);
      if (recur !== REMOVE_TOKEN) out[k] = recur;
    }
    return out;
  }
  return body;
}

function ownMatches(filter: ResponseFilter, obj: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (matches(filter, k, v)) return true;
  }
  return false;
}

function applyItemScope(filter: ResponseFilter, body: unknown, path = "$"): unknown {
  if (Array.isArray(body)) {
    return body
      .map((item, i) => applyItemScope(filter, item, `${path}[${i}]`))
      .filter((item) => item !== REMOVE_TOKEN);
  }
  if (body && typeof body === "object") {
    // "Item" = the nearest object that *directly* owns a matching key/value.
    // Only strike if an own key matches — if the match is deeper, let the
    // recursion find the real item further down.
    if (ownMatches(filter, body as Record<string, unknown>)) {
      return strikeWhole(filter, path);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const recur = applyItemScope(filter, v, `${path}.${k}`);
      if (recur !== REMOVE_TOKEN) out[k] = recur;
    }
    return out;
  }
  return body;
}

function applyEntryScope(filter: ResponseFilter, body: unknown, path = "$"): unknown {
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    body.forEach((item, i) => {
      const here = `${path}[${i}]`;
      if (subtreeMatches(filter, item)) {
        const struck = strikeWhole(filter, here);
        if (struck !== REMOVE_TOKEN) out.push(struck);
        return;
      }
      out.push(item);
    });
    return out;
  }
  // Fall back to ITEM semantics for non-array roots.
  return applyItemScope(filter, body, path);
}

function applyOne(filter: ResponseFilter, body: unknown): unknown {
  const scope = filter.scope ?? "FIELD";
  if (scope === "ITEM") return applyItemScope(filter, body);
  if (scope === "ENTRY") return applyEntryScope(filter, body);
  return applyFieldScope(filter, body);
}

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
