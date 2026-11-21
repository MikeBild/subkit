import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  BatchCreateRequestSchema,
  BatchCreateResponseSchema,
  FileSchema,
  FinalizeRequestSchema,
  InlineUploadSchema,
  MAX_FINALIZE_VERIFY_BYTES,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
} from "../../api/files-schemas.ts";
import {
  deleteFileOperation,
  fileStatsOperation,
  getFileOperation,
  linkFileOperation,
  listFilesOperation,
} from "../../api/operations/files.ts";
import { FileIdParam, toFileWire } from "../../api/operations/files-representation.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { readRequestSource } from "../../audit/index.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import { SCANNER_TIMEOUT_SECONDS } from "../../files/scanner.ts";
import {
  createInlineFile,
  createUploadSlots,
  downloadFile,
  type FileActor,
  finalizeFile,
  findDownloadableFile,
  findUploadSlot,
  storeUpload,
} from "../../files/service/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { gateOtherMethods, requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TAG = "Files";

export function fileActor(c: Context<AppEnv>): FileActor {
  return { principal: requireAuth(c), request_source: readRequestSource(c) };
}

export function registerFileRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/files/:id/upload", requireAnyPermission(["file:write"]));

  const uploadRoute = createRoute({
    method: "put",
    path: "/v1/files/{id}/upload",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "Stored" },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "unauthorized",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(uploadRoute, async (c) => {
    const { id } = c.req.valid("param");
    const fid_uuid = parseFileIdOrThrow(id);
    const db = c.get("db");
    const actor = fileActor(c);
    const slot = await findUploadSlot(db, actor.principal.tenant_id, fid_uuid);
    if (slot.kind === "not_found") {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    if (slot.kind === "conflict") {
      return c.json({ code: "conflict", message: slot.message }, 409);
    }
    const boundSize = slot.row.size_bytes;

    const contentLengthHeader = c.req.header("content-length");
    if (!contentLengthHeader) {
      return c.json({ code: "bad_input", message: "Content-Length is required" }, 400);
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return c.json({ code: "bad_input", message: "Content-Length is invalid" }, 400);
    }
    if (contentLength > boundSize) {
      return c.json(
        {
          code: "too_large",
          message: `body length ${contentLength} exceeds size_bytes=${boundSize}`,
        },
        413,
      );
    }
    if (contentLength !== boundSize) {
      return c.json(
        {
          code: "bad_input",
          message: `body length ${contentLength} must equal size_bytes=${boundSize}`,
        },
        400,
      );
    }

    const raw = c.req.raw.body;
    if (!raw) {
      return c.json({ code: "bad_input", message: "missing body" }, 400);
    }

    await storeUpload(db, actor, slot.row, raw as unknown as AsyncIterable<Uint8Array>);
    return c.body(null, 200);
  });

  app.use("/v1/files", gateOtherMethods(["GET"], requireAnyPermission(["file:read"])));
  app.use("/v1/files/inline", requireAnyPermission(["file:write"]));
  app.use("/v1/files/batch-create", requireAnyPermission(["file:write"]));
  app.use(
    "/v1/files/:id",
    gateOtherMethods(["GET", "DELETE", "PATCH"], requireAnyPermission(["file:read"])),
  );
  app.use("/v1/files/:id/content", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/finalize", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/links", gateOtherMethods(["POST"], requireAnyPermission(["file:write"])));

  const inlineRoute = createRoute({
    method: "post",
    path: "/v1/files/inline",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: InlineUploadSchema } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: FileSchema } },
      },
      200: {
        description: "Dedup hit",
        content: { "application/json": { schema: FileSchema } },
      },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(inlineRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = fileActor(c);
    const started_at = Date.now();

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    } catch {
      return c.json({ code: "bad_input", message: "invalid base64" }, 400);
    }
    if (bytes.byteLength === 0) {
      return c.json({ code: "bad_input", message: "empty content" }, 400);
    }
    if (bytes.byteLength > MAX_INLINE_BYTES) {
      return c.json(
        {
          code: "too_large",
          message: `inline upload exceeds ${MAX_INLINE_BYTES} bytes cap`,
        },
        413,
      );
    }

    const outcome = await createInlineFile(c.get("db"), actor, {
      filename: body.filename,
      content_type: body.content_type ?? null,
      bytes,
      started_at,
    });
    if (outcome.scan_timed_out) {
      c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
    }
    return c.json(toFileWire(outcome.row), outcome.created ? 201 : 200);
  });

  const batchCreateRoute = createRoute({
    method: "post",
    path: "/v1/files/batch-create",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: { "application/json": { schema: BatchCreateRequestSchema } },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: BatchCreateResponseSchema } },
      },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(batchCreateRoute, async (c) => {
    const body = c.req.valid("json");
    const grants = await createUploadSlots(c.get("db"), fileActor(c), body.files);
    const results = grants.map((grant) =>
      grant.dedup
        ? {
            id: toFileId(grant.file_id),
            upload_url: "",
            headers: {},
            expires_in: 0,
            dedup: true,
          }
        : {
            id: toFileId(grant.file_id),
            upload_url: `/v1/files/${toFileId(grant.file_id)}/upload`,
            headers: { "content-length": String(grant.size_bytes) },
            expires_in: grant.expires_in,
            dedup: false,
          },
    );
    return c.json({ files: results }, 201);
  });

  const finalizeRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/finalize",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: {
        content: { "application/json": { schema: FinalizeRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Finalized",
        content: { "application/json": { schema: FileSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
      422: {
        description: "sha256_mismatch",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(finalizeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const outcome = await finalizeFile(c.get("db"), fileActor(c), {
      file_uuid: parseFileIdOrThrow(id),
      sha256: body.sha256,
      started_at: Date.now(),
    });
    switch (outcome.kind) {
      case "not_found":
        return c.json({ code: "not_found", message: "file not found" }, 404);
      case "conflict":
        return c.json(
          { code: "conflict", message: `cannot finalize: status=${outcome.status}` },
          409,
        );
      case "too_large":
        return c.json(
          {
            code: "too_large",
            message: `file size ${outcome.size_bytes} exceeds finalize-verify ceiling of ${MAX_FINALIZE_VERIFY_BYTES} bytes`,
          },
          413,
        );
      case "object_missing":
        return c.json({ code: "not_found", message: "uploaded object not found" }, 404);
      case "sha256_mismatch":
        return c.json(
          {
            code: "sha256_mismatch",
            message: "uploaded bytes hash does not match asserted sha256",
          },
          422,
        );
      case "update_failed":
        return c.json({ code: "internal_error", message: "finalize update failed" }, 404);
      case "finalized":
        if (outcome.scan_timed_out) {
          c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
        }
        return c.json(toFileWire(outcome.row), 200);
    }
  });

  toHonoRoute(app, listFilesOperation);
  toHonoRoute(app, fileStatsOperation);
  toHonoRoute(app, getFileOperation);

  const contentRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/content",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK" },
      206: { description: "Partial Content" },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      416: {
        description: "range_not_satisfiable",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(contentRoute, async (c) => {
    const { id } = c.req.valid("param");
    const actor = fileActor(c);
    const db = c.get("db");
    const row = await findDownloadableFile(db, actor.principal.tenant_id, parseFileIdOrThrow(id));
    if (!row) {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    const total = row.size_bytes;

    const rangeHeader = c.req.header("range");
    let range: { start: number; end: number } | null = null;
    if (rangeHeader?.startsWith("bytes=")) {
      const m = rangeHeader.slice("bytes=".length).match(/^(\d+)-(\d*)$/);
      if (m) {
        const startStr = m[1] ?? "";
        const endStr = m[2] ?? "";
        const start = Number(startStr);
        const end = endStr.length > 0 ? Number(endStr) : total - 1;
        if (start <= end && end < total) {
          range = { start, end };
        } else {
          return c.json({ code: "range_not_satisfiable", message: "range out of bounds" }, 416);
        }
      }
    }

    const stream = await downloadFile(db, actor, row, range);
    if (range) {
      const sliceLen = range.end - range.start + 1;
      return c.body(stream, 206, {
        ...storedContentHeaders(row.content_type, row.filename),
        "content-length": String(sliceLen),
        "content-range": `bytes ${range.start}-${range.end}/${total}`,
        "accept-ranges": "bytes",
      });
    }
    return c.body(stream, 200, {
      ...storedContentHeaders(row.content_type, row.filename),
      "content-length": String(total),
      "accept-ranges": "bytes",
    });
  });

  toHonoRoute(app, deleteFileOperation);
  toHonoRoute(app, linkFileOperation);
}
