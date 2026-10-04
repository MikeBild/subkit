import type { OpenAPIHono } from "@hono/zod-openapi";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerAuthoringRoutes } from "./authoring.ts";
import { registerCallRoutes } from "./call.ts";
import { registerCollectionRoutes } from "./collection.ts";
import { registerCredentialsRoutes } from "./credentials.ts";
import { registerCredentialsSetupRoutes } from "./credentials-setup.ts";
import { registerConnectorMcpRoutes } from "./mcp.ts";
import { registerOAuthRoutes } from "./oauth.ts";
import { registerPromotionRoutes } from "./promotion.ts";
import { registerConnectorRuntimeRoutes } from "./runtime.ts";
import { registerTestRoutes } from "./test.ts";

const RESERVED_CONNECTOR_SEGMENTS = new Set(["validate", "probe", "import", "mcp"]);

export function registerConnectorRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/connectors", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("connector:read")(c, next);
    if (c.req.method === "POST") return requirePermission("connector:write")(c, next);
    return next();
  });
  app.use("/v1/connectors/validate", requirePermission("connector:write"));
  app.use("/v1/connectors/import", requirePermission("connector:write"));
  app.use("/v1/connectors/probe", requirePermission("connector:test"));
  app.use("/v1/connectors/:id", async (c, next) => {
    const id = c.req.param("id");
    if (RESERVED_CONNECTOR_SEGMENTS.has(id)) return next();
    if (c.req.method === "GET") {
      return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
    }
    if (c.req.method === "PATCH") {
      return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("connector:delete", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  for (const segment of ["enable", "disable"] as const) {
    app.use(`/v1/connectors/:id/${segment}`, async (c, next) => {
      const id = c.req.param("id");
      return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
    });
  }
  app.use("/v1/connectors/:id/mcp/inspect", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:test", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/mcp/authorize", async (c, next) => {
    if (c.req.method === "POST") {
      const id = c.req.param("id");
      return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/connectors/:id/runtime", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/credential", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/mcp/tool-confirmation", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:write", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/test", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:test", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/promote", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:promote", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/call", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("connector:read", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/oauth/start", async (c, next) => {
    if (c.req.method === "POST") {
      const id = c.req.param("id");
      return requirePermission("connector:oauth", () => ({ type: "connector", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/connectors/:id/credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });
  app.use("/v1/connectors/:id/credentials/setup", async (_c, next) => next());
  app.use("/v1/connectors/:id/end-user-credentials", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("credential:write", () => ({ type: "connector", id }))(c, next);
  });

  registerAuthoringRoutes(app);
  registerCollectionRoutes(app);
  registerTestRoutes(app);
  registerPromotionRoutes(app);
  registerCallRoutes(app);
  registerOAuthRoutes(app);
  registerCredentialsRoutes(app);
  registerCredentialsSetupRoutes(app);
  registerConnectorMcpRoutes(app);
  registerConnectorRuntimeRoutes(app);
}
