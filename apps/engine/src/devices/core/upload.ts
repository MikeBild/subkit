import {
  IMPORT_MAX_BYTES,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNKS_MAX,
  type UploadRefusal,
} from "@shared/device/uploads.ts";

export type UploadState = "open" | "committed" | "aborted" | "expired";

export interface UploadFacts {
  state: UploadState;
  size_bytes: number;
  expires_at_ms: number;
}

export function sizeAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= IMPORT_MAX_BYTES;
}

function openVerdict(upload: UploadFacts, now_ms: number): UploadRefusal | null {
  if (upload.state !== "open") return "upload_closed";
  if (now_ms >= upload.expires_at_ms) return "upload_expired";
  return null;
}

export function chunkVerdict(
  upload: UploadFacts,
  chunk: { n: number; bytes: number; received_bytes: number; existing_bytes: number | null },
  now_ms: number,
): UploadRefusal | null {
  const closed = openVerdict(upload, now_ms);
  if (closed) return closed;
  if (!Number.isSafeInteger(chunk.n) || chunk.n < 0 || chunk.n >= UPLOAD_CHUNKS_MAX)
    return "chunk_out_of_range";
  if (chunk.bytes > UPLOAD_CHUNK_MAX_BYTES) return "chunk_too_large";
  if (chunk.existing_bytes !== null)
    return chunk.existing_bytes === chunk.bytes ? null : "chunk_conflict";
  if (chunk.received_bytes + chunk.bytes > upload.size_bytes) return "size_mismatch";
  return null;
}

export function commitVerdict(
  upload: UploadFacts,
  commit: { size: number; sha256: string; chunks: readonly number[]; actual_sha256: string },
  now_ms: number,
): UploadRefusal | null {
  const closed = openVerdict(upload, now_ms);
  if (closed) return closed;
  if (commit.size !== upload.size_bytes) return "size_mismatch";
  const indices = [...commit.chunks].sort((a, b) => a - b);
  if (indices.some((n, index) => n !== index)) return "chunks_missing";
  if (commit.actual_sha256 !== commit.sha256) return "hash_mismatch";
  return null;
}

const STATUS: Readonly<Record<UploadRefusal, 404 | 409 | 410 | 413 | 422>> = {
  command_not_found: 404,
  upload_not_found: 404,
  not_an_import: 409,
  command_not_running: 409,
  chunk_conflict: 409,
  upload_closed: 409,
  upload_expired: 410,
  too_large: 413,
  quota_exhausted: 413,
  chunk_too_large: 413,
  chunk_out_of_range: 422,
  size_mismatch: 422,
  chunks_missing: 422,
  hash_mismatch: 422,
};

export function uploadRefusalStatus(code: UploadRefusal): 404 | 409 | 410 | 413 | 422 {
  return STATUS[code];
}
