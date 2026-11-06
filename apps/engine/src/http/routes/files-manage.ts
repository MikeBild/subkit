import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FileIdSchema,
  FileSchema,
  InlineUploadSchema,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
} from "../../api/files-schemas.ts";
import {
  fileUsageOperation,
  listFileVersionsOperation,
  renameFileOperation,
} from "../../api/operations/files.ts";
import { FileIdParam, toFileWire } from "../../api/operations/files-representation.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import {
  downloadFileVersion,
  findLiveFile,
  replaceFileBytes,
  restoreFileVersion,
} from "../../files/service.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { fileActor, gateOtherMethods } from "./files.ts";

const TAG = "Files";

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
  app.use("/v1/files/:id/versions", gateOtherMethods(["GET"], "file:read"));
  app.use("/v1/files/:id/versions/:version/content", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/versions/:version/restore", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/usage", gateOtherMethods(["GET"], "file:read"));

  toHonoRoute(app, renameFileOperation);

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

  toHonoRoute(app, listFileVersionsOperation);

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

  toHonoRoute(app, fileUsageOperation);
}
