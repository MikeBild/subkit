import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { parseFileIdOrThrow } from "../../api/files-schemas.ts";
import {
  fileUsageOperation,
  listFileVersionsOperation,
  renameFileOperation,
  replaceFileOperation,
  restoreFileVersionOperation,
} from "../../api/operations/files.ts";
import { FileVersionParam } from "../../api/operations/files-representation.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import { downloadFileVersion, findLiveFile } from "../../files/service/index.ts";
import { gateOtherMethods, requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { fileActor } from "./files.ts";

const TAG = "Files";

const notFound = { code: "not_found", message: "file not found" } as const;
const versionNotFound = { code: "not_found", message: "file version not found" } as const;

export function registerFileManageRoutes(app: OpenAPIHono<AppEnv>): void {
  const write = requireAnyPermission(["file:write"]);
  const read = requireAnyPermission(["file:read"]);
  app.use("/v1/files/:id/replace", gateOtherMethods(["POST"], write));
  app.use("/v1/files/:id/versions", gateOtherMethods(["GET"], read));
  app.use("/v1/files/:id/versions/:version/content", read);
  app.use("/v1/files/:id/versions/:version/restore", gateOtherMethods(["POST"], write));
  app.use("/v1/files/:id/usage", gateOtherMethods(["GET"], read));

  toHonoRoute(app, renameFileOperation);
  toHonoRoute(app, replaceFileOperation);
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

  toHonoRoute(app, restoreFileVersionOperation);
  toHonoRoute(app, fileUsageOperation);
}
