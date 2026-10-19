import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import { files } from "../db/schema/files.ts";
import { retryTransient } from "../db/transient.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "./object-key.ts";
import { removeStoredFile } from "./remove-stored-file.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS, type ScanResult } from "./scanner.ts";
import { insertFileRow, reviveFileRow } from "./slug.ts";

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
    return {
      row: existing[0].deleted_at ? await reviveFileRow(db as Db, existing[0]) : existing[0],
      dedup: true,
      scan: null,
      scan_timed_out: false,
    };
  }

  const file_uuid = randomUUID();
  const key = buildObjectKey(params.tenant_id, file_uuid);
  const storage_uri = composeStorageUri(key);
  let row: typeof files.$inferSelect;
  try {
    row = await insertFileRow(db as Db, {
      id: file_uuid,
      tenant_id: params.tenant_id,
      status: "pending",
      filename: params.filename,
      content_type: params.content_type,
      size_bytes: params.bytes.byteLength,
      storage_uri,
      sha256,
      upload_url_expires_at: new Date(Date.now() + 3600_000),
      created_by: params.actor_id,
    });
  } catch (err) {
    const [canonical] = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, params.tenant_id), eq(files.sha256, sha256)))
      .limit(1);
    if (!canonical) throw err;
    return {
      row: canonical.deleted_at ? await reviveFileRow(db as Db, canonical) : canonical,
      dedup: true,
      scan: null,
      scan_timed_out: false,
    };
  }
  try {
    await getObjectStore().put(key, params.bytes);
    const scan = await scanWithTimeout(streamFromBytes(params.bytes), {
      content_type: params.content_type,
      filename: params.filename,
    });
    const status =
      scan.verdict === "clean" ? "ready" : scan.verdict === "timeout" ? "scanning" : "failed";
    const [updated] = await retryTransient(() =>
      db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, params.tenant_id);
        return tx
          .update(files)
          .set({ status, scan_result: scan.verdict })
          .where(and(eq(files.tenant_id, params.tenant_id), eq(files.id, row.id)))
          .returning();
      }),
    );
    if (!updated) throw new Error("File reservation disappeared during upload");
    return {
      row: updated,
      dedup: false,
      scan: { verdict: scan.verdict, engine: scan.engine, signature: scan.signature ?? null },
      scan_timed_out: scan.verdict === "timeout",
    };
  } catch (err) {
    await removeStoredFile(db, params.tenant_id, row.id).catch(() => {});
    throw err;
  }
}
