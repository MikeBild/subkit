import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import { files } from "../db/schema/files.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "./object-key.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS, type ScanResult } from "./scanner.ts";
import { insertFileRow } from "./slug.ts";

export interface PersistedScan {
  verdict: string;
  engine: string;
  signature: string | null;
}

export interface PersistInlineUploadResult {
  row: typeof files.$inferSelect;
  dedup: boolean;
  scan: PersistedScan | null;
  scan_timed_out: boolean;
}

const SCAN_TIMEOUT_RESULT: ScanResult = {
  verdict: "timeout",
  engine: "timeout",
};

async function scanWithTimeout(
  stream: AsyncIterable<Uint8Array>,
  meta: { content_type: string | null; filename: string },
): Promise<ScanResult> {
  const timeoutMs = SCANNER_TIMEOUT_SECONDS * 1000;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ScanResult>((resolve) => {
    timerId = setTimeout(() => resolve(SCAN_TIMEOUT_RESULT), timeoutMs);
  });
  try {
    return await Promise.race([getScanner().scan(stream, meta), timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

export async function persistInlineUpload(
  db: Executor,
  params: {
    tenant_id: string;
    actor_id: string | null;
    filename: string;
    content_type: string | null;
    bytes: Uint8Array;
  },
): Promise<PersistInlineUploadResult> {
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");

  const existing = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, params.tenant_id), eq(files.sha256, sha256)))
    .limit(1);
  if (existing[0]) {
    return { row: existing[0], dedup: true, scan: null, scan_timed_out: false };
  }

  const file_uuid = randomUUID();
  const key = buildObjectKey(params.tenant_id, file_uuid);
  const storage_uri = composeStorageUri(key);

  await getObjectStore().put(key, params.bytes);
  try {
    const scan = await scanWithTimeout(streamFromBytes(params.bytes), {
      content_type: params.content_type,
      filename: params.filename,
    });
    const status =
      scan.verdict === "clean" ? "ready" : scan.verdict === "timeout" ? "scanning" : "failed";
    const scanInfo: PersistedScan = {
      verdict: scan.verdict,
      engine: scan.engine,
      signature: scan.signature ?? null,
    };
    try {
      const row = await (db as Db).transaction((tx) =>
        insertFileRow(tx, {
          id: file_uuid,
          tenant_id: params.tenant_id,
          status,
          filename: params.filename,
          content_type: params.content_type,
          size_bytes: params.bytes.byteLength,
          storage_uri,
          sha256,
          scan_result: scan.verdict,
          created_by: params.actor_id,
        }),
      );
      if (row) {
        return {
          row,
          dedup: false,
          scan: scanInfo,
          scan_timed_out: scan.verdict === "timeout",
        };
      }
    } catch (err) {
      const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("files_tenant_sha256_uq") ||
        msg.includes("duplicate key") ||
        causeMsg.includes("files_tenant_sha256_uq") ||
        causeMsg.includes("duplicate key")
      ) {
        const again = await db
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, params.tenant_id), eq(files.sha256, sha256)))
          .limit(1);
        if (again[0]) {
          try {
            await getObjectStore().delete(key);
          } catch {}
          return { row: again[0], dedup: true, scan: null, scan_timed_out: false };
        }
      }
      throw err;
    }
  } catch (err) {
    try {
      await getObjectStore().delete(key);
    } catch {}
    throw err;
  }
  throw new Error("files insert returned no row");
}
