import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { toFileId } from "../api/files-schemas.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { fileLinks, files } from "../db/schema/index.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { insertFileRow } from "./slug.ts";

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
  file_id: string;
  file_uuid: string;
  storage_key: string;
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

export async function attachInlineForTest(
  p: AttachInlineForTestParams,
): Promise<AttachInlineForTestResult> {
  const bytes = typeof p.content === "string" ? new TextEncoder().encode(p.content) : p.content;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

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
  await insertFileRow(p.db, {
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
