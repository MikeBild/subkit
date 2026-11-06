import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  approvePatchCandidateOperation,
  dryRunPatchCandidateOperation,
  getPatchCandidateOperation,
  listPatchCandidatesOperation,
  preparePatchCandidateOperation,
  previewPatchCandidateOperation,
  rejectPatchCandidateOperation,
} from "../../api/operations/patch-candidates.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerPatchCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/patch-candidates/:id/approve",
    gateOtherMethods(["POST"], requirePermission("workflow:write")),
  );
  app.use(
    "/v1/patch-candidates/:id/reject",
    gateOtherMethods(["POST"], requirePermission("workflow:write")),
  );
  app.use(
    "/v1/patch-candidates/:id/prepare",
    gateOtherMethods(["POST"], requirePermission("workflow:write")),
  );
  toHonoRoute(app, preparePatchCandidateOperation);
  app.use(
    "/v1/patch-candidates/:id/preview",
    gateOtherMethods(["GET", "HEAD"], requirePermission("workflow:read")),
  );
  app.use(
    "/v1/patch-candidates/:id/dry-run",
    gateOtherMethods(["POST"], requirePermission("workflow:read")),
  );

  toHonoRoute(app, listPatchCandidatesOperation);
  toHonoRoute(app, getPatchCandidateOperation);
  toHonoRoute(app, previewPatchCandidateOperation);
  toHonoRoute(app, dryRunPatchCandidateOperation);
  toHonoRoute(app, approvePatchCandidateOperation);
  toHonoRoute(app, rejectPatchCandidateOperation);
}
