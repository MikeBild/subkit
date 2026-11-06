import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  listMcpPromptsOperation,
  listMcpResourcesOperation,
  listMcpToolsOperation,
} from "../../api/operations/mcp-catalog.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerMcpCatalogRoutes(app: OpenAPIHono<AppEnv>): void {
  const read = gateOtherMethods(["GET", "HEAD"], requirePermission("mcp:read"));
  app.use("/v1/mcp/prompts", read);
  app.use("/v1/mcp/resources", read);
  app.use("/v1/mcp/tools", read);

  toHonoRoute(app, listMcpPromptsOperation);
  toHonoRoute(app, listMcpResourcesOperation);
  toHonoRoute(app, listMcpToolsOperation);
}
