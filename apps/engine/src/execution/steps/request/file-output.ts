import { toFileId } from "../../../api/files-schemas.ts";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
} from "../../../audit/index.ts";
import type { Db } from "../../../db/client.ts";
import { recordFilesDedupSeen } from "../../../files/dedup-counter.ts";
import { linkStoredFile } from "../../../files/links.ts";
import { persistInlineUpload } from "../../../files/persist-inline-upload.ts";
import { getContext } from "../../../logging/context.ts";
import { logger } from "../../../logging/index.ts";

interface WorkflowFileOutputEnvelope {
  file: { $file: string };
  filename: string;
  content_type: string | null;
  size_bytes: number;
}

export async function linkWorkflowOutputFile(args: {
  db: Db;
  tenant_id: string;
  execution_id: string;
  file: { id: string; filename: string; content_type: string | null; size_bytes: number };
}): Promise<WorkflowFileOutputEnvelope> {
  await linkStoredFile(
    args.db,
    {
      tenant_id: args.tenant_id,
      file_id: args.file.id,
      resource_type: "workflow_run",
      resource_id: args.execution_id,
      slug: null,
      role: "output",
    },
    {
      actor_type: "system",
      actor_id: null,
      request_source: getContext().request_source ?? "tool-chain",
      source: "workflow_output",
      allowed_statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
    },
  );
  return {
    file: { $file: toFileId(args.file.id) },
    filename: args.file.filename,
    content_type: args.file.content_type,
    size_bytes: args.file.size_bytes,
  };
}

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

  const envelope = await linkWorkflowOutputFile({
    db: args.db,
    tenant_id: args.tenant_id,
    execution_id: args.execution_id,
    file: row,
  });

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

  return envelope;
}
