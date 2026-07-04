// Workflow file outputs — persist a promoted HTTP response body as an
// engine-managed file.
//
// The HTTP driver returns `body_raw` (raw bytes, never UTF-8 decoded)
// when a 2xx response matches `shouldPromoteToFile`. This module owns
// the persistence side effect: bytes → `files` row (sha256 dedup, scan,
// object-store write via `persistInlineUpload`) → `file_links` row
// (`resource_type: "workflow_run"`, `role: "output"`) → audit — and
// returns the step-output envelope.
//
// Envelope contract: the inner `{"$file": "fid_…"}` leaf is EXACTLY
// single-key so (a) `isFileRef` in `files/resolver.ts` matches it when
// a downstream step feeds `${steps.<id>.file}` into a multipart part or
// binary body, and (b) sk-cli's `collectFileRefs` walker finds it and
// prints the download hint on `sk executions get` — no CLI change
// needed. Metadata lives as sibling keys so selectors can read
// `filename` / `size_bytes` without resolving bytes.

import { toFileId } from "../../../api/files-schemas.ts";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  FileLinkAddedMetadataSchema,
} from "../../../audit/index.ts";
import type { Db } from "../../../db/client.ts";
import { fileLinks } from "../../../db/schema/files.ts";
import { recordFilesDedupSeen } from "../../../files/dedup-counter.ts";
import { persistInlineUpload } from "../../../files/persist-inline-upload.ts";
import { logger } from "../../../logging/logger.ts";

export interface WorkflowFileOutputEnvelope {
  file: { $file: string };
  filename: string;
  content_type: string | null;
  size_bytes: number;
}

/** Persist promoted response bytes as a workflow-run output file and
 *  return the step-output envelope. The step succeeds even when the
 *  scanner timed out (`status='scanning'`) — the run output must
 *  reference the file either way; the cleanup cron resolves the scan
 *  verdict on its own schedule. */
export async function promoteResponseToFile(args: {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  execution_id: string;
  step_id: string;
  filename: string;
  content_type: string | null;
  bytes: Buffer;
}): Promise<WorkflowFileOutputEnvelope> {
  const persisted = await persistInlineUpload(args.db, {
    tenant_id: args.tenant_id,
    actor_id: args.actor_id,
    filename: args.filename,
    content_type: args.content_type,
    bytes: args.bytes,
  });
  const { row, dedup } = persisted;

  if (dedup) {
    await recordFilesDedupSeen(args.db, args.tenant_id);
  } else {
    await auditAwait(
      {
        tenant_id: args.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.FILE_CREATED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileCreatedMetadataSchema.parse({
          file_id: row.id,
          size_bytes_bucket: bucketSize(row.size_bytes),
          content_type: row.content_type,
          filename: row.filename.slice(0, 255),
          sha256_prefix: row.sha256?.slice(0, 16),
          dedup: false,
        }),
      },
      args.db,
    );
  }

  // Link to the run. `slug: null` on purpose — retries and loop
  // iterations of the same step may promote several files per run; a
  // step-id slug would collide on the per-resource unique index while
  // NULL slugs coexist.
  await args.db
    .insert(fileLinks)
    .values({
      tenant_id: args.tenant_id,
      file_id: row.id,
      resource_type: "workflow_run",
      resource_id: args.execution_id,
      slug: null,
      role: "output",
    })
    .onConflictDoNothing();

  await auditAwait(
    {
      tenant_id: args.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.FILE_LINK_ADDED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileLinkAddedMetadataSchema.parse({
        file_id: row.id,
        resource_type: "workflow_run",
        resource_id: args.execution_id,
        slug: null,
        role: "output",
        source: "workflow_output",
      }),
    },
    args.db,
  );

  logger.info({
    module: "execution",
    action: "request.file_output_promoted",
    tenant_id: args.tenant_id,
    execution_id: args.execution_id,
    step_id: args.step_id,
    file_id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    dedup,
  });

  return {
    file: { $file: toFileId(row.id) },
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
  };
}
