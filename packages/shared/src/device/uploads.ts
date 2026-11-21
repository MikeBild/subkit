import { z } from "zod";

export const IMPORT_MAX_BYTES = 90 * 1024 * 1024;
export const UPLOAD_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_CHUNKS_MAX = 4096;
export const UPLOAD_LIFETIME_MS = 60 * 60_000;

export const RUNNER_UPLOAD_ROUTES = {
  create: "/v1/device-runner/uploads",
  chunk: (id: string, n: number) =>
    `/v1/device-runner/uploads/${encodeURIComponent(id)}/chunks/${n}`,
  commit: (id: string) => `/v1/device-runner/uploads/${encodeURIComponent(id)}/commit`,
  abort: (id: string) => `/v1/device-runner/uploads/${encodeURIComponent(id)}`,
} as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const UploadCreateSchema = z
  .object({
    command_id: Sha256Schema,
    name: z.string().min(1).max(255),
    size: z.number().int().min(0).max(IMPORT_MAX_BYTES),
  })
  .strict();
export type UploadCreate = z.infer<typeof UploadCreateSchema>;

export const UploadCreatedSchema = z
  .object({
    upload_id: z.string().uuid(),
    chunk_bytes_max: z.number().int().positive(),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type UploadCreated = z.infer<typeof UploadCreatedSchema>;

export const UploadChunkReceiptSchema = z
  .object({ received_bytes: z.number().int().nonnegative() })
  .strict();

export const UploadCommitSchema = z
  .object({ sha256: Sha256Schema, size: z.number().int().min(0) })
  .strict();
export type UploadCommit = z.infer<typeof UploadCommitSchema>;

export const UploadCommittedSchema = z.object({ file_id: z.string().uuid() }).strict();
export type UploadCommitted = z.infer<typeof UploadCommittedSchema>;

export const UPLOAD_REFUSALS = [
  "command_not_found",
  "not_an_import",
  "command_not_running",
  "upload_not_found",
  "too_large",
  "quota_exhausted",
  "upload_closed",
  "upload_expired",
  "chunk_out_of_range",
  "chunk_too_large",
  "chunk_conflict",
  "size_mismatch",
  "chunks_missing",
  "hash_mismatch",
] as const;
export type UploadRefusal = (typeof UPLOAD_REFUSALS)[number];
