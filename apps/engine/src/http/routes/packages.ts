import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { FileIdSchema, parseFileId, toFileId } from "../../api/files-schemas.ts";
import {
  PackageApplyRequestSchema,
  PackageApplyResultSchema,
  PackageExportRequestSchema,
  PackageExportResultSchema,
  PackageInstallDetailSchema,
  PackageInstallListSchema,
  PackagePreviewJsonRequestSchema,
  PackagePreviewResultSchema,
} from "../../api/packages-schemas.ts";
import {
  AuditAction,
  actorOf,
  actorType,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import { getConfig } from "../../config/loader.ts";
import {
  applyPackageImport,
  exportTenantPackage,
  getPackageInstall,
  listPackageInstalls,
  loadStoredPackageArchive,
  PACKAGE_CONTENT_TYPE,
  PACKAGE_MAX_BYTES,
  PackageArchiveError,
  PackageArchiveNotFoundError,
  PackagePlanChangedError,
  PackageTooLargeError,
  previewPackageImport,
  storePackageArchive,
} from "../../identity/index.ts";
import { HttpError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";

const InstallIdParam = z.object({ id: z.string().uuid() });
const ArchiveIdParam = z.object({ file_id: FileIdSchema });

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

function publicInstance(): string | null {
  try {
    const base = getConfig().server.public_base_url;
    if (base && base.length > 0) return base.endsWith("/") ? base.slice(0, -1) : base;
  } catch {}
  return null;
}

function requireFileUuid(wire: string): string {
  const uuid = parseFileId(wire);
  if (uuid === null) throw new HttpError(400, "bad_request", "invalid file id");
  return uuid;
}

function contentLengthOverCap(c: Context): boolean {
  const raw = c.req.header("content-length");
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > PACKAGE_MAX_BYTES;
}

function mapPackageError(err: unknown): never {
  if (err instanceof PackagePlanChangedError) {
    throw new HttpError(409, "package_plan_changed", "the import plan changed since preview", {
      hint: "Review the returned plan and apply again with its plan_digest.",
      details: { plan: err.plan },
    });
  }
  if (err instanceof PackageArchiveError) {
    const status = err.code === "package_archive_too_large" ? 413 : 400;
    throw new HttpError(status, err.code, err.detail);
  }
  if (err instanceof PackageArchiveNotFoundError) {
    throw new HttpError(404, "not_found", "package archive not found", {
      hint: "Upload the archive again with POST /v1/packages/import/preview.",
    });
  }
  if (err instanceof PackageTooLargeError) {
    throw new HttpError(413, "package_too_large", "package exceeds the size limit", {
      details: { total_bytes: err.total_bytes, limit_bytes: err.limit_bytes },
      hint: "Export fewer kinds with the kinds filter.",
    });
  }
  throw err;
}

function contentDispositionName(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return safe.length > 0 ? safe : "package.zip";
}

function iso(value: Date): string {
  return value.toISOString();
}

type InstallRow = Awaited<ReturnType<typeof listPackageInstalls>>[number];

function installView(row: InstallRow) {
  return {
    id: row.id,
    package_id: row.package_id,
    package_version: row.package_version,
    format: row.format,
    content_digest: row.content_digest,
    archive_file_id: row.archive_file_id ? toFileId(row.archive_file_id) : null,
    source: row.source,
    installed_by_type: row.installed_by_type,
    installed_by_id: row.installed_by_id,
    summary: row.summary,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const exportRoute = createRoute({
  method: "post",
  path: "/v1/packages/export",
  tags: ["packages"],
  summary: "Export the tenant as a package archive",
  description:
    "Collects workflows, connectors without secrets, skills, files, schedules and knowledge into a stored package archive. Download it with GET /v1/packages/archives/{file_id}.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: PackageExportRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Package archive stored",
      content: { "application/json": { schema: PackageExportResultSchema } },
    },
    400: errorResponse("Invalid request"),
    413: errorResponse("Package exceeds the size limit"),
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/v1/packages/archives/{file_id}",
  tags: ["packages"],
  summary: "Download a stored package archive",
  description: "The x-subkit-sha256 response header verifies the archive bytes.",
  security: [{ bearerAuth: [] }],
  request: { params: ArchiveIdParam },
  responses: {
    200: {
      description: "Package archive",
      content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
    },
    400: errorResponse("Invalid file id"),
    404: errorResponse("Package archive not found"),
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/v1/packages/import/preview",
  tags: ["packages"],
  summary: "Preview a package import",
  description:
    "Upload an archive as multipart field `archive`, or reference a stored archive by archive_file_id. Returns the stored archive id and the plan to confirm with POST /v1/packages/import/apply.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: {
        "application/json": { schema: PackagePreviewJsonRequestSchema },
        "multipart/form-data": {
          schema: {
            type: "object",
            required: ["archive"],
            properties: {
              archive: { type: "string", format: "binary", description: "Package archive" },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Import plan",
      content: { "application/json": { schema: PackagePreviewResultSchema } },
    },
    400: errorResponse("Invalid archive or request"),
    404: errorResponse("Package archive not found"),
    413: errorResponse("Archive exceeds the size limit"),
  },
});

const applyRoute = createRoute({
  method: "post",
  path: "/v1/packages/import/apply",
  tags: ["packages"],
  summary: "Apply a previewed package import",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PackageApplyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Import result",
      content: { "application/json": { schema: PackageApplyResultSchema } },
    },
    400: errorResponse("Invalid archive or request"),
    404: errorResponse("Package archive not found"),
    409: errorResponse("The plan changed since preview; details.plan holds the current plan"),
    413: errorResponse("Archive exceeds the size limit"),
  },
});

const listInstallsRoute = createRoute({
  method: "get",
  path: "/v1/packages/installs",
  tags: ["packages"],
  summary: "List package installs",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Package installs",
      content: { "application/json": { schema: PackageInstallListSchema } },
    },
  },
});

const getInstallRoute = createRoute({
  method: "get",
  path: "/v1/packages/installs/{id}",
  tags: ["packages"],
  summary: "Get one package install with its items",
  security: [{ bearerAuth: [] }],
  request: { params: InstallIdParam },
  responses: {
    200: {
      description: "Package install",
      content: { "application/json": { schema: PackageInstallDetailSchema } },
    },
    404: errorResponse("Package install not found"),
  },
});

async function readUploadedArchive(c: Context): Promise<{ filename: string; bytes: Buffer }> {
  if (contentLengthOverCap(c)) {
    throw new HttpError(413, "package_archive_too_large", "archive exceeds the size limit");
  }
  const form = await c.req.formData();
  const archive = form.get("archive");
  if (!(archive instanceof File)) {
    throw new HttpError(400, "bad_request", "multipart 'archive' file is required");
  }
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (bytes.byteLength > PACKAGE_MAX_BYTES) {
    throw new HttpError(413, "package_archive_too_large", "archive exceeds the size limit");
  }
  return { filename: archive.name || "package.zip", bytes };
}

export function registerPackageRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/packages/export", requirePermission("package:export"));
  app.use("/v1/packages/archives/*", requirePermission("package:export"));
  app.use("/v1/packages/import/*", requirePermission("package:import"));
  app.use("/v1/packages/installs", requirePermission("package:import"));
  app.use("/v1/packages/installs/*", requirePermission("package:import"));

  app.openapi(exportRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json") as z.infer<typeof PackageExportRequestSchema>;
    try {
      const result = await exportTenantPackage(c.get("db"), {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: readRequestSource(c) ?? "api",
        kinds: body.kinds,
        source: { instance: publicInstance(), engine_version: OPENAPI_INFO.version },
      });
      return c.json({ ...result, file_id: toFileId(result.file_id) }, 201);
    } catch (err) {
      mapPackageError(err);
    }
  });

  app.openapi(downloadRoute, async (c) => {
    const principal = requireAuth(c);
    const { file_id } = c.req.valid("param");
    const uuid = requireFileUuid(file_id);
    try {
      const stored = await loadStoredPackageArchive(c.get("db"), principal.tenant_id, uuid);
      const sha256 = stored.sha256 ?? createHash("sha256").update(stored.bytes).digest("hex");
      return c.body(new Uint8Array(stored.bytes), 200, {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${contentDispositionName(stored.filename)}"`,
        "content-length": String(stored.bytes.byteLength),
        "content-type": "application/zip",
        "x-subkit-sha256": sha256,
      });
    } catch (err) {
      mapPackageError(err);
    }
  });

  app.openapi(previewRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const contentType = c.req.header("content-type") ?? "";
    try {
      if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        const upload = await readUploadedArchive(c);
        const plan = await previewPackageImport(db, principal.tenant_id, upload.bytes);
        const fileId = await storePackageArchive(db, {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          filename: upload.filename,
          bytes: upload.bytes,
        });
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: actorType(principal),
            actor_id: principal.id,
            action: AuditAction.FILE_CREATED,
            resource_type: "file",
            resource_id: fileId,
            result: "success",
            metadata: FileCreatedMetadataSchema.parse({
              file_id: fileId,
              filename: upload.filename.slice(0, 255),
              content_type: PACKAGE_CONTENT_TYPE,
              size_bytes_bucket: bucketSize(upload.bytes.byteLength),
              sha256_prefix: createHash("sha256").update(upload.bytes).digest("hex").slice(0, 16),
              request_source: readRequestSource(c),
              source: "package_import_preview",
            }),
          },
          db,
        );
        return c.json({ archive_file_id: toFileId(fileId), plan }, 200);
      }
      const parsed = PackagePreviewJsonRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new HttpError(
          400,
          "bad_request",
          "send a multipart 'archive' file or JSON {archive_file_id}",
        );
      }
      const uuid = requireFileUuid(parsed.data.archive_file_id);
      const stored = await loadStoredPackageArchive(db, principal.tenant_id, uuid);
      const plan = await previewPackageImport(db, principal.tenant_id, stored.bytes);
      return c.json({ archive_file_id: toFileId(stored.file_id), plan }, 200);
    } catch (err) {
      mapPackageError(err);
    }
  });

  app.openapi(applyRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const uuid = requireFileUuid(body.archive_file_id);
    try {
      const stored = await loadStoredPackageArchive(db, principal.tenant_id, uuid);
      const result = await applyPackageImport(db, {
        tenant_id: principal.tenant_id,
        archive: stored.bytes,
        archive_file_id: stored.file_id,
        expected_plan_digest: body.expected_plan_digest,
        who: {
          actor: actorOf(principal),
          actor_type: actorType(principal),
          request_source: readRequestSource(c) ?? "api",
        },
      });
      return c.json(result, 200);
    } catch (err) {
      mapPackageError(err);
    }
  });

  app.openapi(listInstallsRoute, async (c) => {
    const principal = requireAuth(c);
    const rows = await listPackageInstalls(c.get("db"), principal.tenant_id);
    return c.json({ items: rows.map(installView) }, 200);
  });

  app.openapi(getInstallRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const found = await getPackageInstall(c.get("db"), principal.tenant_id, id);
    if (!found) throw new HttpError(404, "not_found", "package install not found");
    return c.json(
      {
        ...installView(found.install),
        items: found.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          item_key: item.item_key,
          local_id: item.local_id,
          imported_hash: item.imported_hash,
          local_hash: item.local_hash,
          state: item.state,
          intake_proposal_id: item.intake_proposal_id,
          created_at: iso(item.created_at),
          updated_at: iso(item.updated_at),
        })),
      },
      200,
    );
  });
}
