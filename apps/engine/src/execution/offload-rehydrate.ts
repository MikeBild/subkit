// Deep re-hydration of `OffloadRef` placeholders embedded in a scope
// value. The loop runner (engine.ts) substitutes `OffloadRef`s into the
// in-memory `scope` so a loop's `iterationResults` array holds bounded
// references instead of N full payload envelopes — the OOM fix. Before
// any value crosses an external surface (persisted execution result,
// validator input, `data_selector` input) or is handed to author
// JSONata, every embedded `OffloadRef` MUST be resolved back to the
// original payload.
//
// This module owns that traversal so engine.ts and jsonata-bindings.ts
// share one implementation. A re-hydration failure throws
// `OffloadResolutionError` — never a silent fallback.

import type { Db } from "../db/client.ts";
import { isOffloadRef, type OffloadRef, resolveOffloaded } from "./offload.ts";

/**
 * Recursively walk `value`, replacing every `OffloadRef` with its
 * re-hydrated payload via `resolveOffloaded`. Resolution is filtered by
 * `tenant_id` (the cross-tenant isolation predicate lives in
 * `resolveOffloaded`).
 *
 * Returns the input unchanged (same reference) when no `OffloadRef` is
 * present, so a loop with no downstream consumer never re-materialises.
 * Throws `OffloadResolutionError` on the first unreadable ref — the
 * consuming step fails with a typed error rather than seeing truncated
 * data.
 */
export async function deepResolveOffloadRefs(
  db: Db,
  tenant_id: string,
  value: unknown,
): Promise<unknown> {
  if (!containsOffloadRef(value)) return value;
  return resolveNode(db, tenant_id, value);
}

/** Cheap pre-scan: true when `value` holds at least one `OffloadRef`. */
export function containsOffloadRef(value: unknown): boolean {
  if (isOffloadRef(value)) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsOffloadRef(item)) return true;
    }
    return false;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (containsOffloadRef(v)) return true;
    }
  }
  return false;
}

/**
 * Synchronous, DB-free counterpart to `deepResolveOffloadRefs`: walk
 * `value` and collapse every `OffloadRef` to a small marker object
 * carrying its inline `preview` string. Used for preview surfaces
 * (step summaries the LLM reads) where re-hydrating the full payload
 * from storage would be wasteful — the operator/LLM only needs a
 * sample. Returns the input unchanged when no `OffloadRef` is present.
 */
export function previewOffloadRefs(value: unknown): unknown {
  if (!containsOffloadRef(value)) return value;
  if (isOffloadRef(value)) {
    const ref = value as OffloadRef;
    return {
      _offloaded: true,
      storage_uri: ref.storage_uri,
      size_bytes: ref.size_bytes,
      preview: ref.preview,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => previewOffloadRefs(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = previewOffloadRefs(v);
    }
    return out;
  }
  return value;
}

async function resolveNode(db: Db, tenant_id: string, value: unknown): Promise<unknown> {
  if (isOffloadRef(value)) {
    const resolved = await resolveOffloaded(db, tenant_id, value as OffloadRef);
    // The re-hydrated payload itself cannot contain an OffloadRef
    // (offload stores plain JSON), so no recursion into `resolved`.
    return resolved;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await resolveNode(db, tenant_id, item));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveNode(db, tenant_id, v);
    }
    return out;
  }
  return value;
}
