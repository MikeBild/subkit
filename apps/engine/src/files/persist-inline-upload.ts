// Shared inline-upload pipeline: sha256 → dedup-probe → put → scan
// (with timeout) → insert → race-recovery. Used by:
//
//   - `POST /v1/files/inline` (canonical route, `apps/engine/src/http/routes/files.ts`)
//   - `POST /v1/conversations/:id/attachments` inline branch
//     (portal-wrapper, `apps/engine/src/http/routes/conversation-attachments.ts`)
//
// Consolidates the dedup + insert + scan sequence so a future change
// (extra storage backend, new dedup key, scanner upgrade) lands once.
// Audit emission stays with the caller — the two routes have subtly
// different audit shapes (the portal wrapper tags emissions with
// `source: "conversation_attachments"`; the canonical route does not),
// and that asymmetry is the SIEM-side discriminator we want to keep
// visible at the call site rather than buried in a flag parameter.
//
// Scanner-timeout handling: when the scanner exceeds
// `SCANNER_TIMEOUT_SECONDS` the helper resolves with a `timeout`
// verdict and inserts the row in `status='scanning'` (NOT `ready`).
// The caller decides whether to surface a `Retry-After` header and
// whether to record a per-route metric.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { files } from "../db/schema/files.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "./object-key.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS, type ScanResult } from "./scanner.ts";
import { insertFileRow } from "./slug.ts";

/** Scanner output the caller mirrors into a `FILE_SCAN_COMPLETED`
 *  audit row. `null` is returned on the dedup branch — no fresh scan
 *  ran, so no audit row to emit. */
export interface PersistedScan {
  verdict: string;
  engine: string;
  signature: string | null;
}

export interface PersistInlineUploadResult {
  row: typeof files.$inferSelect;
  /** True when an existing `(tenant_id, sha256)` row was reused. */
  dedup: boolean;
  /** Fresh-insert scan result; `null` on dedup. */
  scan: PersistedScan | null;
  /** True when the scanner timed out — the row is in `status='scanning'`
   *  and the caller should surface a `Retry-After` header so clients
   *  poll `GET /v1/files/{id}` instead of treating the scan as complete. */
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

/** Persist bytes into the canonical `files` table with dedup, scan,
 *  and race-recovery on the `(tenant_id, sha256)` unique index. */
export async function persistInlineUpload(
  db: Db,
  params: {
    tenant_id: string;
    actor_id: string | null;
    filename: string;
    content_type: string | null;
    bytes: Uint8Array;
  },
): Promise<PersistInlineUploadResult> {
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");

  // Dedup-probe. The unique index `files_tenant_sha256_uq` is the
  // source of truth — we probe first and fall back to a SELECT on
  // unique-violation below in case two requests race.
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

  // Write bytes first; the row commit makes the file discoverable.
  await getObjectStore().put(key, params.bytes);

  // Scan synchronously with a hard timeout. On timeout we leave the row
  // in `status='scanning'` and rely on the cleanup cron to reap stuck
  // rows after the documented grace.
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
    const row = await insertFileRow(db, {
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
    });
    if (row) {
      return {
        row,
        dedup: false,
        scan: scanInfo,
        scan_timed_out: scan.verdict === "timeout",
      };
    }
  } catch (err) {
    // Concurrent dedup race: catch the unique violation, re-SELECT.
    // Drizzle wraps PG errors as DrizzleQueryError whose `.message` is
    // "Failed query: …"; the original PG constraint message lives in
    // `.cause.message`. Check both so the race path works regardless
    // of whether the error is unwrapped or not.
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
        // Roll back the object we wrote — the existing row's
        // storage_uri is canonical.
        try {
          await getObjectStore().delete(key);
        } catch {
          /* best-effort */
        }
        return { row: again[0], dedup: true, scan: null, scan_timed_out: false };
      }
    }
    throw err;
  }
  throw new Error("files insert returned no row");
}
