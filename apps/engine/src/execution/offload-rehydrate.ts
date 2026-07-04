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
import { isOffloadRef, type OffloadRef, redactStorageUri, resolveOffloaded } from "./offload.ts";

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
  signal?: AbortSignal,
): Promise<unknown> {
  if (!containsOffloadRef(value)) return value;
  return resolveNode(db, tenant_id, value, signal);
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
 * `value` and collapse every `OffloadRef` to a plain SCALAR string
 * marker. Used for preview surfaces (loop/parallel step summaries the
 * LLM reads, themselves returned in `RunResult` over the REST surface)
 * where re-hydrating the full payload from storage would be wasteful.
 *
 * The marker is a primitive string — `[offloaded:<scheme>://…:<n>B]`
 * — deliberately NOT a structured object. A preview that survives this
 * collapse can never carry an object discriminant (`$offloaded` /
 * `_offloaded`), so the primitive type alone proves no payload (and no
 * `OffloadRef`) leaked onto an external surface. Returns the input
 * unchanged when no `OffloadRef` is present.
 *
 * The locator is REDACTED to its scheme (`s3://…` / `fixture://…`) via
 * the same `redactStorageUri` helper the error `.message` uses — the
 * full `s3://<bucket>/<key>` / `fixture://<uuid>` exposes the offload
 * backend layout and must never reach `output_preview` (LLM-readable
 * on the REST surface).
 */
export function previewOffloadRefs(value: unknown): unknown {
  // Per-node fast path: a sub-tree with no `OffloadRef` is returned by
  // reference, un-walked and un-reallocated. Without this the recursion
  // descended into (and rebuilt) every clean node below the first ref.
  if (!containsOffloadRef(value)) return value;
  if (isOffloadRef(value)) {
    const ref = value as OffloadRef;
    return `[offloaded:${redactStorageUri(ref.storage_uri)}:${ref.size_bytes}B]`;
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

async function resolveNode(
  db: Db,
  tenant_id: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (isOffloadRef(value)) {
    const resolved = await resolveOffloaded(db, tenant_id, value as OffloadRef, signal);
    // The re-hydrated payload itself cannot contain an OffloadRef
    // (offload stores plain JSON), so no recursion into `resolved`.
    return resolved;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await resolveNode(db, tenant_id, item, signal));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveNode(db, tenant_id, v, signal);
    }
    return out;
  }
  return value;
}
