import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  approveDiscoveryArtifactOperation,
  getDiscoveryArtifactOperation,
  getDiscoveryRunOperation,
  listCapabilityGapsOperation,
  listDiscoveryArtifactsOperation,
  listDiscoveryRunsOperation,
  rejectDiscoveryArtifactOperation,
  resolveCapabilityGapOperation,
} from "../../api/operations/discovery.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  AuditAction,
  actorOf,
  actorType,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  FileLinkAddedMetadataSchema,
  FileScanCompletedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import * as svc from "../../discovery/index.ts";
import { DiscoveryRunSchema, extractCodebaseArchive } from "../../discovery/index.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export const MAX_DISCOVERY_UPLOAD_BYTES = 100 * 1024 * 1024;

export function contentLengthOverCap(c: {
  req: { header: (n: string) => string | undefined };
}): boolean {
  const cl = c.req.header("content-length");
  if (!cl) return false;
  const n = Number(cl);
  return Number.isFinite(n) && n > MAX_DISCOVERY_UPLOAD_BYTES;
}

const DiscoveryUploadErrorSchema = z.object({ error: z.string() }).openapi("DiscoveryUploadError");

const DiscoveryArchiveUploadErrorSchema = z
  .object({
    error: z.string(),
    skipped_reasons: z.record(z.string(), z.number()).optional(),
  })
  .openapi("DiscoveryArchiveUploadError");

const DiscoveryRunWithArchiveStatsSchema = DiscoveryRunSchema.extend({
  archive_stats: z.object({
    extracted_count: z.number().int(),
    skipped_count: z.number().int(),
    skipped_reasons: z.record(z.string(), z.number()),
    total_bytes: z.number().int(),
    truncated: z.boolean(),
  }),
}).openapi("DiscoveryRunWithArchiveStats");

const createRunRoute = createRoute({
  method: "post",
  path: "/v1/discovery/runs",
  tags: ["discovery"],
  summary: "Create a discovery run from uploaded files",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["files"],
            properties: {
              files: {
                type: "array",
                items: { type: "string", format: "binary" },
                description:
                  "Files to analyze — repeat the field per file. Max 50 files, 100 MB total.",
              },
              label: { type: "string", description: "Optional human-readable run label." },
            },
          },
        },
      },
    },
  },
  responses: {
    202: {
      description: "Accepted — run created, analysis pending",
      content: { "application/json": { schema: DiscoveryRunSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: DiscoveryUploadErrorSchema } },
    },
    413: {
      description: "Upload exceeds the size cap",
      content: { "application/json": { schema: DiscoveryUploadErrorSchema } },
    },
  },
});

const createRunFromArchiveRoute = createRoute({
  method: "post",
  path: "/v1/discovery/runs/from-archive",
  tags: ["discovery"],
  summary: "Create a discovery run from a codebase archive",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["archive"],
            properties: {
              archive: {
                type: "string",
                format: "binary",
                description: "Zip archive of a codebase. Max 100 MB.",
              },
              label: { type: "string", description: "Optional human-readable run label." },
            },
          },
        },
      },
    },
  },
  responses: {
    202: {
      description: "Accepted — run created, analysis pending",
      content: { "application/json": { schema: DiscoveryRunWithArchiveStatsSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: DiscoveryArchiveUploadErrorSchema } },
    },
    413: {
      description: "Archive exceeds the size cap",
      content: { "application/json": { schema: DiscoveryUploadErrorSchema } },
    },
  },
});

export function registerDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  for (const path of ["/v1/discovery/runs", "/v1/discovery/runs/from-archive"])
    app.use(path, async (c, next) =>
      c.req.method === "GET" ? next() : requirePermission("discovery:approve")(c, next),
    );

  toHonoRoute(app, listDiscoveryRunsOperation);
  toHonoRoute(app, getDiscoveryRunOperation);
  toHonoRoute(app, listDiscoveryArtifactsOperation);
  toHonoRoute(app, getDiscoveryArtifactOperation);
  toHonoRoute(app, approveDiscoveryArtifactOperation);
  toHonoRoute(app, listCapabilityGapsOperation);
  toHonoRoute(app, resolveCapabilityGapOperation);
  toHonoRoute(app, rejectDiscoveryArtifactOperation);

  app.openapi(createRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    if (contentLengthOverCap(c)) {
      return c.json({ error: "upload exceeds 100MB limit" }, 413);
    }
    const formData = await c.req.formData();
    const label = formData.get("label");
    const files = formData.getAll("files");

    if (files.length === 0) {
      return c.json({ error: "at least one file is required" }, 400);
    }
    if (files.length > 50) {
      return c.json({ error: "maximum 50 files per run" }, 400);
    }

    const parsedFiles: Array<{ buffer: Buffer; filename: string; mime?: string }> = [];
    let totalBytes = 0;
    for (const file of files) {
      if (!(file instanceof File)) continue;
      const buffer = Buffer.from(await file.arrayBuffer());
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_DISCOVERY_UPLOAD_BYTES) {
        return c.json({ error: "upload exceeds 100MB limit" }, 413);
      }
      parsedFiles.push({
        buffer,
        filename: file.name,
        ...(file.type ? { mime: file.type } : {}),
      });
    }

    const run = await svc.createDiscoveryRun(
      {
        tenant_id: principal.tenant_id,
        files: parsedFiles,
        actor_id: principal.id,
        actor: actorOf(principal),
        ...(typeof label === "string" ? { label } : {}),
      },
      db,
    );

    return c.json(run, 202);
  });

  app.openapi(createRunFromArchiveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    if (contentLengthOverCap(c)) {
      return c.json({ error: "archive exceeds 100MB limit" }, 413);
    }
    const formData = await c.req.formData();
    const label = formData.get("label");
    const archive = formData.get("archive");

    if (!(archive instanceof File)) {
      return c.json({ error: "multipart 'archive' file is required" }, 400);
    }
    const archiveBuffer = Buffer.from(await archive.arrayBuffer());
    if (archiveBuffer.byteLength > MAX_DISCOVERY_UPLOAD_BYTES) {
      return c.json({ error: "archive exceeds 100MB limit" }, 413);
    }

    let extracted: Awaited<ReturnType<typeof extractCodebaseArchive>>;
    try {
      extracted = await extractCodebaseArchive(archiveBuffer);
    } catch (err) {
      return c.json(
        { error: `archive extraction failed: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }
    if (extracted.files.length === 0) {
      return c.json(
        {
          error:
            "no analysable files found after filtering (all entries were binaries, lockfiles, or generated artifacts)",
          skipped_reasons: extracted.skipped_reasons,
        },
        400,
      );
    }

    const {
      row: archiveFile,
      dedup,
      scan,
    } = await persistInlineUpload(db, {
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      filename: archive.name,
      content_type: archive.type ? archive.type : null,
      bytes: archiveBuffer,
    });
    if (dedup) {
      await recordFilesDedupSeen(db, principal.tenant_id);
    }

    const run = await svc.createDiscoveryRun(
      {
        tenant_id: principal.tenant_id,
        files: extracted.files,
        actor_id: principal.id,
        actor: actorOf(principal),
        archive_file_id: archiveFile.id,
        ...(typeof label === "string" ? { label } : {}),
      },
      db,
    );

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_CREATED,
        resource_type: "file",
        resource_id: archiveFile.id,
        result: "success",
        metadata: FileCreatedMetadataSchema.parse({
          file_id: archiveFile.id,
          filename: archive.name.slice(0, 255),
          content_type: archive.type ? archive.type : null,
          size_bytes_bucket: bucketSize(archiveBuffer.byteLength),
          sha256_prefix: archiveFile.sha256 ? archiveFile.sha256.slice(0, 16) : undefined,
          dedup,
          request_source: readRequestSource(c),
          source: "discovery_from_archive",
        }),
      },
      db,
    );
    if (scan) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_SCAN_COMPLETED,
          resource_type: "file",
          resource_id: archiveFile.id,
          result:
            scan.verdict === "clean" ? "success" : scan.verdict === "timeout" ? "error" : "denied",
          metadata: FileScanCompletedMetadataSchema.parse({
            file_id: archiveFile.id,
            verdict: scan.verdict,
            engine: scan.engine,
            signature: scan.signature,
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_LINK_ADDED,
        resource_type: "file",
        resource_id: archiveFile.id,
        result: "success",
        metadata: FileLinkAddedMetadataSchema.parse({
          file_id: archiveFile.id,
          resource_type: "discovery_run",
          resource_id: run.id,
          role: "archive",
          request_source: readRequestSource(c),
          source: "discovery_from_archive",
        }),
      },
      db,
    );

    return c.json(
      {
        ...run,
        archive_stats: {
          extracted_count: extracted.files.length,
          skipped_count: extracted.skipped_count,
          skipped_reasons: extracted.skipped_reasons,
          total_bytes: extracted.total_bytes,
          truncated: extracted.truncated,
        },
      },
      202,
    );
  });
}
