// Test helpers for the unified files resource.
//
// Inserts a `files` row + `file_links` row directly so attachment-aware
// tests don't have to spin up the full HTTP route. The bytes land in
// the configured object store (in-process MemoryObjectStore in tests,
// the test overrode it via `setObjectStoreForTesting`), keeping the
// content read path identical to production — `requireFileForTenant`
// + `openRead` see the same shape they'd see for a real upload.
//
// IMPORTANT: this helper bypasses the HTTP route layer — no `audit_log`
// row is written at attach time. Tests that assert on `audit_log` must
// drive uploads via the real route (fetch `/v1/files/inline`) to
// exercise the emission path.
//
// Used by:
//   - `apps/engine/src/conversations/tests/attachments-resolver.test.ts`
//   - `apps/engine/src/conversations/tests/save-connector-draft-analysis.test.ts`
//   - `apps/engine/src/llm/flows/tests/analyze-conversation-attachments.test.ts`
//
// Returns the canonical wire-format file id (`fid_<uuid>`) so callers
// can splice it into `$file` refs the same way production clients do.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { toFileId } from "../api/files-schemas.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { fileLinks, files } from "../db/schema/index.ts";
import { getObjectStore } from "../storage/object-store.ts";

export interface AttachInlineForTestParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  filename: string;
  content: string | Uint8Array;
  content_type?: string;
  slug?: string;
}

export interface AttachInlineForTestResult {
  /** Wire-format file id (`fid_<uuid>`). */
  file_id: string;
  /** Raw UUID (no `fid_` prefix) for direct DB joins. */
  file_uuid: string;
  /** Storage backend key the bytes were written under. */
  storage_key: string;
  /** Slug attached to the link row. */
  slug: string;
}

function buildObjectKey(tenant_id: string, file_uuid: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${tenant_id}/${yyyy}/${mm}/${dd}/${file_uuid}`;
}

function composeStorageUri(key: string): string {
  try {
    const bucket = getConfig().storage.object_store.bucket || "test";
    return `s3://${bucket}/${key}`;
  } catch {
    return `s3://test/${key}`;
  }
}

function slugify(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const sanitised = stem.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitised.length === 0 ? `file-${Date.now().toString(36)}` : sanitised.slice(0, 48);
}

/**
 * Attach a file to a conversation through the production path: write
 * bytes to the object store, insert a `files` row, link it via
 * `file_links`. Returns the wire-format file id so tests can splice it
 * into `$file` refs or assert against `lookupSlugsToFileIds`.
 */
export async function attachInlineForTest(
  p: AttachInlineForTestParams,
): Promise<AttachInlineForTestResult> {
  const bytes = typeof p.content === "string" ? new TextEncoder().encode(p.content) : p.content;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Same (tenant_id, sha256) dedup as the production pipeline — a second
  // attach of identical bytes reuses the existing row instead of
  // violating files_tenant_sha256_uq (knowledge/discovery persistence
  // also creates files rows now, so identical fixture bytes collide).
  const existing = await p.db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, p.tenant_id), eq(files.sha256, sha256)))
    .limit(1);
  if (existing[0]) {
    const slugExisting = p.slug ?? slugify(p.filename);
    await p.db
      .insert(fileLinks)
      .values({
        tenant_id: p.tenant_id,
        file_id: existing[0].id,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        slug: slugExisting,
        role: "attachment",
      })
      .onConflictDoNothing();
    // local://<key> carries the key verbatim; s3://<bucket>/<key> nests
    // it one segment deeper.
    const uri = existing[0].storage_uri;
    const storage_key = uri.startsWith("s3://")
      ? uri.replace(/^s3:\/\/[^/]+\//, "")
      : uri.replace(/^local:\/\//, "");
    return {
      file_id: toFileId(existing[0].id),
      file_uuid: existing[0].id,
      storage_key,
      slug: slugExisting,
    };
  }

  const file_uuid = randomUUID();
  const key = buildObjectKey(p.tenant_id, file_uuid);
  const storage_uri = composeStorageUri(key);
  await getObjectStore().put(key, bytes);
  await p.db.insert(files).values({
    id: file_uuid,
    tenant_id: p.tenant_id,
    status: "ready",
    filename: p.filename,
    content_type: p.content_type ?? null,
    size_bytes: bytes.byteLength,
    storage_uri,
    sha256,
    scan_result: "clean",
  });
  const slug = p.slug ?? slugify(p.filename);
  await p.db.insert(fileLinks).values({
    tenant_id: p.tenant_id,
    file_id: file_uuid,
    resource_type: "conversation",
    resource_id: p.conversation_id,
    slug,
    role: "attachment",
  });
  return { file_id: toFileId(file_uuid), file_uuid, storage_key: key, slug };
}
