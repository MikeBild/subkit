import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
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
import {
  DiscoveryArtifactSchema,
  DiscoveryRunSchema,
  extractCodebaseArchive,
} from "../../discovery/index.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RunIdParam = z.object({ id: z.string().uuid() });
const ArtifactIdParam = z.object({ id: z.string().uuid() });

export const MAX_DISCOVERY_UPLOAD_BYTES = 100 * 1024 * 1024;

export function contentLengthOverCap(c: {
  req: { header: (n: string) => string | undefined };
}): boolean {
  const cl = c.req.header("content-length");
  if (!cl) return false;
  const n = Number(cl);
  return Number.isFinite(n) && n > MAX_DISCOVERY_UPLOAD_BYTES;
}

const DiscoveryRunListResponse = z
  .object({ items: z.array(DiscoveryRunSchema) })
  .openapi("DiscoveryRunListResponse");

const DiscoveryArtifactListResponse = z
  .object({ items: z.array(DiscoveryArtifactSchema) })
  .openapi("DiscoveryArtifactListResponse");

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

const listRunsRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs",
  tags: ["discovery"],
  summary: "List discovery runs",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        status: z.enum(["pending", "analyzing", "synthesizing", "completed", "failed"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListDiscoveryRunsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryRunListResponse } },
    },
  },
});

const getRunRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs/{id}",
  tags: ["discovery"],
  summary: "Get a discovery run",
  security: [{ bearerAuth: [] }],
  request: { params: RunIdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryRunSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listArtifactsRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs/{id}/artifacts",
  tags: ["discovery"],
  summary: "List artifacts for a discovery run",
  security: [{ bearerAuth: [] }],
  request: {
    params: RunIdParam,
    query: z
      .object({
        kind: z.enum(["connector", "skill", "knowledge_source"]).optional(),
        status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListDiscoveryArtifactsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryArtifactListResponse } },
    },
  },
});

const getArtifactRoute = createRoute({
  method: "get",
  path: "/v1/discovery/artifacts/{id}",
  tags: ["discovery"],
  summary: "Get a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: { params: ArtifactIdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryArtifactSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const approveArtifactRoute = createRoute({
  method: "post",
  path: "/v1/discovery/artifacts/{id}/approve",
  tags: ["discovery"],
  summary: "Approve a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: { params: ArtifactIdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({
              approved: z.boolean(),
              materialized_id: z.string().nullable(),
              materialized_type: z.string().nullable(),
            })
            .openapi("ApproveDiscoveryArtifactResponse"),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectArtifactRoute = createRoute({
  method: "post",
  path: "/v1/discovery/artifacts/{id}/reject",
  tags: ["discovery"],
  summary: "Reject a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: {
    params: ArtifactIdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ reason: z.string().optional() })
            .openapi("RejectDiscoveryArtifactBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ rejected: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const CapabilityGapSchema = z
  .object({
    id: z.string(),
    status: z.enum(["proposed", "approved", "rejected", "superseded"]),
    state: z.enum(["open", "accepted", "declined", "resolved"]),
    missing_capability: z.string().nullable(),
    requested: z.string(),
    suggested_kind: z.enum(["connector", "workflow", "knowledge", "unknown"]),
    occurrences: z.number().int(),
    resolution: z.object({ note: z.string(), resolved_at: z.string() }).nullable(),
    decline_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("CapabilityGap");

const listCapabilityGapsRoute = createRoute({
  method: "get",
  path: "/v1/discovery/capability-gaps",
  tags: ["discovery"],
  summary: "List capability gaps with their state",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(CapabilityGapSchema) }).openapi("CapabilityGapList"),
        },
      },
    },
  },
});

const resolveCapabilityGapRoute = createRoute({
  method: "post",
  path: "/v1/discovery/capability-gaps/{id}/resolve",
  tags: ["discovery"],
  summary: "Mark an open or accepted capability gap as resolved",
  security: [{ bearerAuth: [] }],
  request: {
    params: ArtifactIdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ note: z.string().trim().min(1).max(2000) })
            .openapi("ResolveCapabilityGapBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: CapabilityGapSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/discovery/*", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("discovery:read")(c, next);
    return requirePermission("discovery:approve")(c, next);
  });

  app.openapi(listRunsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await svc.listDiscoveryRuns(
      {
        tenant_id: principal.tenant_id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(getRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const run = await svc.getDiscoveryRun(principal.tenant_id, id, db);
    if (!run) throw new NotFoundError("discovery_run");
    return c.json(run, 200);
  });

  app.openapi(listArtifactsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await svc.listDiscoveryArtifacts(
      {
        tenant_id: principal.tenant_id,
        run_id: id,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(getArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const artifact = await svc.getDiscoveryArtifact(principal.tenant_id, id, db);
    if (!artifact) throw new NotFoundError("discovery_artifact");
    return c.json(artifact, 200);
  });

  app.openapi(approveArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await svc.approveDiscoveryArtifact(
      {
        tenant_id: principal.tenant_id,
        artifact_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      db,
    );
    if (!result) throw new NotFoundError("discovery_artifact");
    return c.json({ approved: true, ...result }, 200);
  });

  app.openapi(listCapabilityGapsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const gaps = await svc.listCapabilityGaps(
      {
        tenant_id: principal.tenant_id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      },
      db,
    );
    return c.json({ items: gaps.map(svc.toCapabilityGapView) }, 200);
  });

  app.openapi(resolveCapabilityGapRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const gap = await svc.resolveCapabilityGap(
      {
        tenant_id: principal.tenant_id,
        artifact_id: id,
        note: body.note,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      db,
    );
    if (!gap) throw new NotFoundError("capability_gap");
    return c.json(svc.toCapabilityGapView(gap), 200);
  });

  app.openapi(rejectArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rejected = await svc.rejectDiscoveryArtifact(
      {
        tenant_id: principal.tenant_id,
        artifact_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    if (!rejected) throw new NotFoundError("discovery_artifact");
    return c.json({ rejected: true }, 200);
  });

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
