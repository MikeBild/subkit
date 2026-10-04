import type { Db } from "../db/client.ts";
import { isOffloadRef, type OffloadRef, redactStorageUri, resolveOffloaded } from "./offload.ts";

export async function deepResolveOffloadRefs(
  db: Db,
  tenant_id: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!containsOffloadRef(value)) return value;
  return resolveNode(db, tenant_id, value, signal);
}

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

export function previewOffloadRefs(value: unknown): unknown {
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
