import { toFileId } from "../api/files-schemas.ts";
import {
  AuditAction,
  actorType,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
} from "../audit/index.ts";
import { linkStoredFile } from "../files/links.ts";
import { persistInlineUpload } from "../files/persist-inline-upload.ts";
import { OPENAPI_INFO } from "../http/openapi.ts";
import { collectDiagnosticContext, type DiagnosticContext } from "./diagnostic-context.ts";
import { DIAGNOSTIC_COLLECTION_BYTES, diagnosticParts } from "./diagnostic-parts.ts";

async function persistExport(ctx: DiagnosticContext, filename: string, bytes: Uint8Array) {
  const principal = ctx.principal;
  if (!principal) throw new Error("Authenticated caller required");
  const saved = await persistInlineUpload(ctx.db, {
    tenant_id: ctx.tenant_id,
    actor_id: principal.id,
    filename,
    content_type: "application/json",
    bytes,
  });
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      actor_type: actorType(principal),
      actor_id: principal.id,
      action: AuditAction.FILE_CREATED,
      resource_type: "file",
      resource_id: saved.row.id,
      result: "success",
      metadata: FileCreatedMetadataSchema.parse({
        file_id: saved.row.id,
        filename,
        content_type: "application/json",
        size_bytes_bucket: bucketSize(bytes.byteLength),
        sha256_prefix: saved.row.sha256?.slice(0, 16),
        dedup: saved.dedup,
        request_source: "chat",
      }),
    },
    ctx.db,
  );
  await linkStoredFile(
    ctx.db,
    {
      tenant_id: ctx.tenant_id,
      file_id: saved.row.id,
      resource_type: "conversation",
      resource_id: ctx.conversation_id,
      role: "execution_data",
    },
    {
      actor_type: actorType(principal),
      actor_id: principal.id,
      request_source: "chat",
      source: "diagnostic_export",
      allowed_statuses: ["ready"],
    },
  );
  if (!saved.row.sha256) throw new Error("Diagnostic export checksum unavailable");
  return { id: toFileId(saved.row.id), sha256: saved.row.sha256 };
}

export async function exportDiagnosticContext(ctx: DiagnosticContext, now: Date) {
  const artifacts = await collectDiagnosticContext(ctx, now);
  const parts: ReturnType<typeof diagnosticParts> = [];
  const manifestArtifacts = [];
  let remaining = DIAGNOSTIC_COLLECTION_BYTES - 2;
  for (const artifact of artifacts) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact.data));
    if (bytes.byteLength > remaining) {
      manifestArtifacts.push({
        name: artifact.name,
        media_type: "application/json",
        status: "unavailable",
        reason: "The case's 10 MB collection limit was reached.",
        parts: [],
      });
      continue;
    }
    const file = await persistExport(ctx, `${artifact.name}.json`, bytes);
    const artifactParts = diagnosticParts(artifact.name, file.id, bytes);
    parts.push(...artifactParts);
    remaining -= bytes.byteLength;
    manifestArtifacts.push({
      name: artifact.name,
      media_type: "application/json",
      status: artifact.status,
      ...(artifact.reason ? { reason: artifact.reason } : {}),
      parts: artifactParts.map(({ data: _data, ...part }) => part),
    });
  }
  const manifest = {
    collected_at: now.toISOString(),
    window_start: new Date(now.getTime() - 86_400_000).toISOString(),
    window_end: now.toISOString(),
    artifacts: manifestArtifacts,
  };
  const inputFile = await persistExport(
    ctx,
    "diagnostic-transfer.json",
    new TextEncoder().encode(
      JSON.stringify({ parts, manifest, engine_version: OPENAPI_INFO.version }),
    ),
  );
  return {
    input_file: inputFile,
    bytes: DIAGNOSTIC_COLLECTION_BYTES - 2 - remaining,
    artifact_count: manifestArtifacts.length,
    part_count: parts.length,
    collection_complete: manifestArtifacts.every((artifact) => artifact.status === "complete"),
    unavailable: manifestArtifacts
      .filter((artifact) => artifact.status !== "complete")
      .map(({ name, reason }) => ({ name, reason })),
  };
}
