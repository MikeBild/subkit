import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getSelfHealingScanOperation,
  listSelfHealingScansOperation,
  runSelfHealingScanOperation,
} from "../../api/operations/self-healing.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSelfHealingRoutes(app: OpenAPIHono<AppEnv>): void {
  const read = requirePermission("self_healing:read");
  app.use("/v1/self-healing/scans", gateOtherMethods(["GET", "HEAD", "POST"], read));
  app.use("/v1/self-healing/scans/:id", gateOtherMethods(["GET", "HEAD"], read));

  toHonoRoute(app, runSelfHealingScanOperation);
  toHonoRoute(app, listSelfHealingScansOperation);
  toHonoRoute(app, getSelfHealingScanOperation);
}
