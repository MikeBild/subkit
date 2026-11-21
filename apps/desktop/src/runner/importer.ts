import {
  UPLOAD_CHUNK_MAX_BYTES,
  type UploadCommit,
  UploadCommittedSchema,
  type UploadCreate,
  UploadCreatedSchema,
} from "@shared/device/uploads.ts";
import type { Importer, ImportSession } from "./files/context.ts";

export interface UploadPort {
  create(body: UploadCreate): Promise<unknown>;
  chunk(uploadId: string, n: number, bytes: Uint8Array): Promise<void>;
  commit(uploadId: string, body: UploadCommit): Promise<unknown>;
  abort(uploadId: string): Promise<void>;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createImporter(port: UploadPort): Importer {
  return {
    async begin(meta) {
      const created = UploadCreatedSchema.safeParse(
        await port.create({ command_id: meta.command_id, name: meta.name, size: meta.size }),
      );
      if (!created.success) return null;
      const uploadId = created.data.upload_id;
      const limit = Math.min(created.data.chunk_bytes_max, UPLOAD_CHUNK_MAX_BYTES);
      let parts: Uint8Array[] = [];
      let buffered = 0;
      let next = 0;
      let size = 0;
      const flush = async (all: boolean) => {
        while (buffered >= limit || (all && buffered > 0)) {
          const joined = concat(parts, buffered);
          const take = Math.min(limit, joined.length);
          await port.chunk(uploadId, next, joined.slice(0, take));
          next += 1;
          const rest = joined.slice(take);
          parts = rest.length > 0 ? [rest] : [];
          buffered = rest.length;
        }
      };
      const session: ImportSession = {
        async write(chunk) {
          parts.push(chunk);
          buffered += chunk.length;
          size += chunk.length;
          await flush(false);
        },
        async commit(sha256) {
          await flush(true);
          const committed = UploadCommittedSchema.safeParse(
            await port.commit(uploadId, { sha256, size }),
          );
          return committed.success ? { file_id: committed.data.file_id } : null;
        },
        async abort() {
          await port.abort(uploadId).catch(() => {});
        },
      };
      return session;
    },
  };
}
