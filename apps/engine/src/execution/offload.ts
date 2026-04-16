// Large-payload offload. When a serialized step result exceeds the
// threshold (10 KB), the engine writes it to the `execution_fixtures`
// table with `kind = 'offload'`, returns the row id as the
// `result_storage_uri`, and persists a 512-byte preview alongside it.
//
// In a future phase the offload may be redirected to S3; the public
// interface stays the same.

import type { Db } from "../db/client.ts";
import { executionFixtures } from "../db/schema/index.ts";

export const OFFLOAD_THRESHOLD_BYTES = 10 * 1024;
export const PREVIEW_BYTES = 512;

export interface OffloadResult {
  storage_uri: string | null; // 'fixture://<uuid>' or null if inline
  preview: string | null; // truncated string preview if offloaded
  size_bytes: number;
}

export function previewOf(value: unknown): string {
  const s = JSON.stringify(value) ?? "null";
  return s.length > PREVIEW_BYTES ? s.slice(0, PREVIEW_BYTES) : s;
}

export interface MaybeOffloadParams {
  tenant_id: string;
  execution_id: string;
  step_id?: string | null;
  result: unknown;
}

export async function maybeOffload(db: Db, params: MaybeOffloadParams): Promise<OffloadResult> {
  const serialized = JSON.stringify(params.result) ?? "null";
  const size = Buffer.byteLength(serialized, "utf8");
  if (size <= OFFLOAD_THRESHOLD_BYTES) {
    return { storage_uri: null, preview: null, size_bytes: size };
  }
  // Insert the full payload and return its id.
  const [row] = await db
    .insert(executionFixtures)
    .values({
      tenant_id: params.tenant_id,
      kind: "offload",
      execution_id: params.execution_id,
      step_id: params.step_id ?? null,
      body: params.result as object,
      byte_size: size,
    })
    .returning({ id: executionFixtures.id });
  if (!row) throw new Error("offload insert returned no row");
  return {
    storage_uri: `fixture://${row.id}`,
    preview: serialized.slice(0, PREVIEW_BYTES),
    size_bytes: size,
  };
}
