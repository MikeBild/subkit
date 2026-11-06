import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FILE_VERSION_RETENTION,
  FileIdSchema,
  FileSchema,
  FileUsageSchema,
  FileVersionListSchema,
  InlineUploadSchema,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
  UpdateFileSchema,
} from "../../api/files-schemas.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import {
  downloadFileVersion,
  fileUsage,
  findLiveFile,
  findTenantFile,
  replaceFileBytes,
  restoreFileVersion,
  updateFileDetails,
} from "../../files/service.ts";
import { listFileVersions } from "../../files/versions.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { fileActor, toFileWire } from "./files.ts";

const TAG = "Files";

const FileIdParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
});

const notFound = { code: "not_found", message: "file not found" } as const;
const versionNotFound = { code: "not_found", message: "file version not found" } as const;

const FileVersionParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
  version: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: "version", in: "path" }, type: "integer" }),
});

function duplicate(twinId: string) {
  return {
    code: "duplicate_content",
    message: "another stored file already has exactly this content",
    hint: `Use the existing file ${toFileId(twinId)} instead.`,
  };
}

export function registerFileManageRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/files/:id/replace", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/versions", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/versions/:version/content", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/versions/:version/restore", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/usage", requireAnyPermission(["file:read"]));

  const renameRoute = createRoute({
    method: "patch",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: UpdateFileSchema } } },
    },
    responses: {
      400: {
        description: "Invalid description acceptance",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "The reviewed description changed",
        content: { "application/json": { schema: ErrorSchema } },
      },
      200: { description: "Updated", content: { "application/json": { schema: FileSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(renameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await updateFileDetails(c.get("db"), fileActor(c), parseFileIdOrThrow(id), body);
    if (!row) return c.json(notFound, 404);
    return c.json(toFileWire(row), 200);
  });

  const replaceRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/replace",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: InlineUploadSchema } } },
    },
    responses: {
      200: {
        description: "Replaced; the id and every reference to it are unchanged",
        content: { "application/json": { schema: FileSchema } },
      },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: {
        description: "duplicate_content",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
      422: {
        description: "scan_rejected",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(replaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = fileActor(c);
    const db = c.get("db");
    const row = await findLiveFile(db, actor.principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) return c.json(notFound, 404);

    const bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    if (bytes.byteLength === 0) return c.json({ code: "bad_input", message: "empty content" }, 400);
    if (bytes.byteLength > MAX_INLINE_BYTES)
      return c.json(
        { code: "too_large", message: `replacement exceeds ${MAX_INLINE_BYTES} bytes cap` },
        413,
      );

    const result = await replaceFileBytes(db, actor, row, {
      filename: body.filename,
      content_type: body.content_type ?? null,
      bytes,
    });
    if (result.kind === "scan_rejected")
      return c.json(
        {
          code: "scan_rejected",
          message:
            result.verdict === "timeout"
              ? "the content could not be checked in time; nothing was replaced"
              : "the content did not pass the scan; nothing was replaced",
        },
        422,
      );
    if (result.kind === "duplicate") return c.json(duplicate(result.twinId), 409);
    if (result.kind === "not_found") return c.json(notFound, 404);
    return c.json(toFileWire(result.row), 200);
  });

  const versionsRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/versions",
    tags: [TAG],
    summary: "List a file's content versions, newest first",
    description: `The current content and every earlier content kept after a replace or restore, newest first. \`current\` marks the content the file serves now. The newest ${FILE_VERSION_RETENTION} earlier versions are kept; deleting the file removes all of them.`,
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: FileVersionListSchema } },
      },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(versionsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const row = await findLiveFile(db, principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) return c.json(notFound, 404);
    return c.json({ items: await listFileVersions(db, principal.tenant_id, row) }, 200);
  });

  const versionContentRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/versions/{version}/content",
    tags: [TAG],
    summary: "Download one content version of a file",
    security: [{ bearerAuth: [] }],
    request: { params: FileVersionParam },
    responses: {
      200: { description: "OK" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(versionContentRoute, async (c) => {
    const { id, version } = c.req.valid("param");
    const actor = fileActor(c);
    const db = c.get("db");
    const row = await findLiveFile(db, actor.principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) return c.json(notFound, 404);
    const download = await downloadFileVersion(db, actor, row, version);
    if (!download) return c.json(versionNotFound, 404);
    return c.body(download.stream, 200, {
      ...storedContentHeaders(download.source.content_type, download.source.filename),
      "content-length": String(download.source.size_bytes),
    });
  });

  const restoreRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/versions/{version}/restore",
    tags: [TAG],
    summary: "Make an earlier content version the file's content again",
    description:
      "Restores the content of an earlier version as a new version. The content it replaces stays in the history, so a restore can be undone the same way. The id and every reference stay unchanged.",
    security: [{ bearerAuth: [] }],
    request: { params: FileVersionParam },
    responses: {
      200: {
        description: "Restored as the newest version",
        content: { "application/json": { schema: FileSchema } },
      },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: {
        description: "duplicate_content or current_version",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(restoreRoute, async (c) => {
    const { id, version } = c.req.valid("param");
    const actor = fileActor(c);
    const db = c.get("db");
    const row = await findLiveFile(db, actor.principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) return c.json(notFound, 404);
    const result = await restoreFileVersion(db, actor, row, version);
    if (result.kind === "current_version")
      return c.json(
        { code: "current_version", message: `version ${version} is already the current content` },
        409,
      );
    if (result.kind === "version_not_found") return c.json(versionNotFound, 404);
    if (result.kind === "duplicate") return c.json(duplicate(result.twinId), 409);
    if (result.kind === "not_found") return c.json(notFound, 404);
    return c.json(toFileWire(result.row), 200);
  });

  const usageRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/usage",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: FileUsageSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(usageRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const row = await findTenantFile(db, principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) return c.json(notFound, 404);
    return c.json(await fileUsage(db, principal, row), 200);
  });
}
