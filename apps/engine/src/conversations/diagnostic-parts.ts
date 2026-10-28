import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { FileIdSchema } from "../api/files-schemas.ts";

export const DiagnosticArtifactSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    media_type: z.enum(["application/json", "application/x-ndjson", "text/plain"]),
    status: z.enum(["complete", "partial", "unavailable", "failed"]),
    reason: z.string().optional(),
  })
  .strict();

export const DIAGNOSTIC_PART_BYTES = 262_144;
export const DIAGNOSTIC_COLLECTION_BYTES = 10_000_000;

export function diagnosticParts(artifact: string, fileId: string, bytes: Uint8Array) {
  const name = DiagnosticArtifactSchema.shape.name.parse(artifact);
  const id = FileIdSchema.parse(fileId);
  if (bytes.byteLength === 0 || bytes.byteLength > DIAGNOSTIC_COLLECTION_BYTES)
    throw new Error("Diagnostic artifact size is outside the supported range");
  const parts = [];
  for (let start = 0; start < bytes.byteLength; start += DIAGNOSTIC_PART_BYTES) {
    const chunk = bytes.subarray(start, start + DIAGNOSTIC_PART_BYTES);
    parts.push({
      artifact: name,
      index: parts.length,
      sha256: createHash("sha256").update(chunk).digest("hex"),
      bytes: chunk.byteLength,
      data: { $file: id, $range: { start, length: chunk.byteLength } },
    });
  }
  return parts;
}
