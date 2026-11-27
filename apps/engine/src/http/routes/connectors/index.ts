import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  attachConnectorCredentialsOperation,
  callConnectorOperation,
  confirmLocalCommandOperation,
  getConnectorCredentialOperation,
  testConnectorOperation,
  toHonoRoute,
} from "../../../api/index.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerAuthoringRoutes } from "./authoring.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerCredentialsSetupRoutes } from "./credentials-setup.ts";
import { registerConnectorMcpRoutes } from "./mcp.ts";
import { registerOAuthRoutes } from "./oauth.ts";
import { registerPromotionRoutes } from "./promotion.ts";
import { registerConnectorRuntimeRoutes } from "./runtime.ts";

export function registerConnectorRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/connectors/validate", async (c, next) => {
    if (c.req.method === "POST") return next();
    return requirePermission("connector:write")(c, next);
  });

  registerAuthoringRoutes(app);
  registerCollectionRoutes(app);
  toHonoRoute(app, testConnectorOperation);
  registerPromotionRoutes(app);
  toHonoRoute(app, confirmLocalCommandOperation);
  toHonoRoute(app, callConnectorOperation);
  registerOAuthRoutes(app);
  toHonoRoute(app, getConnectorCredentialOperation);
  toHonoRoute(app, attachConnectorCredentialsOperation);
  registerCredentialsSetupRoutes(app);
  registerConnectorMcpRoutes(app);
  registerConnectorRuntimeRoutes(app);
}
