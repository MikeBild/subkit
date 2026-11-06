import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getKnowledgeVersionOperation,
  listKnowledgeHistoryOperation,
  restoreKnowledgeVersionOperation,
} from "../../api/operations/knowledge-version.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerKnowledgeVersionRoutes(app: OpenAPIHono<AppEnv>): void {
  const read = requirePermission("knowledge:read");
  app.use("/v1/knowledge-sources/:id/history", gateOtherMethods(["GET", "HEAD"], read));
  app.use("/v1/knowledge-sources/:id/history/:version", gateOtherMethods(["GET", "HEAD"], read));
  app.use(
    "/v1/knowledge-sources/:id/restore/:version",
    gateOtherMethods(["POST"], requirePermission("knowledge:write")),
  );

  toHonoRoute(app, listKnowledgeHistoryOperation);
  toHonoRoute(app, getKnowledgeVersionOperation);
  toHonoRoute(app, restoreKnowledgeVersionOperation);
}
