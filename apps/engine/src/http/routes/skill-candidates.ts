import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  approveSkillCandidateOperation,
  approveSkillCandidatesOperation,
  getSkillCandidateOperation,
  listSkillCandidateEvidenceOperation,
  listSkillCandidatesOperation,
  rejectSkillCandidateOperation,
} from "../../api/operations/skill-candidates.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSkillCandidateRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/skill-candidates",
    gateOtherMethods(["GET", "HEAD"], requirePermission("skill:read")),
  );
  app.use(
    "/v1/skill-candidates/approve",
    gateOtherMethods(["POST"], requirePermission("skill:write")),
  );
  app.use(
    "/v1/skill-candidates/approve",
    gateOtherMethods(["POST"], requirePermission("skill:activate")),
  );
  app.use("/v1/skill-candidates/:id", gateOtherMethods(["GET"], requirePermission("skill:write")));
  app.use(
    "/v1/skill-candidates/:id/evidence",
    gateOtherMethods(["GET", "HEAD"], requirePermission("skill:read")),
  );
  app.use(
    "/v1/skill-candidates/:id/approve",
    gateOtherMethods(["POST"], requirePermission("skill:write")),
  );
  app.use(
    "/v1/skill-candidates/:id/reject",
    gateOtherMethods(["POST"], requirePermission("skill:write")),
  );

  toHonoRoute(app, listSkillCandidatesOperation);
  toHonoRoute(app, getSkillCandidateOperation);
  toHonoRoute(app, listSkillCandidateEvidenceOperation);
  toHonoRoute(app, approveSkillCandidateOperation);
  toHonoRoute(app, approveSkillCandidatesOperation);
  toHonoRoute(app, rejectSkillCandidateOperation);
}
