import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  createWorkflowOperation,
  deleteWorkflowOperation,
  updateWorkflowOperation,
  validateWorkflowOperation,
} from "../../api/operations/workflow-authoring.ts";
import { getWorkflowInputSchemaOperation } from "../../api/operations/workflow-input-schema.ts";
import {
  createScheduleOperation,
  deleteScheduleOperation,
  listSchedulesOperation,
  updateScheduleOperation,
} from "../../api/operations/workflow-schedules.ts";
import {
  getWorkflowOperation,
  listWorkflowsOperation,
  updateWorkflowMetadataOperation,
} from "../../api/operations/workflows.ts";
import type { AppEnv } from "../openapi.ts";
import { registerWorkflowAuthorityRoutes } from "./workflow-authorities.ts";
import { registerWorkflowDiagnosisRoutes } from "./workflow-diagnosis.ts";
import { registerWorkflowDraftRoutes } from "./workflow-drafts.ts";
import { registerWorkflowInvocationRoutes } from "./workflow-invocation.ts";
import { registerTransactionalMailRoutes } from "./workflow-transactional-mail.ts";
import { registerWorkflowVersionRoutes } from "./workflow-versions.ts";

export function registerWorkflowRoutes(app: OpenAPIHono<AppEnv>): void {
  registerWorkflowAuthorityRoutes(app);
  registerTransactionalMailRoutes(app);
  registerWorkflowDiagnosisRoutes(app);
  registerWorkflowInvocationRoutes(app);
  registerWorkflowDraftRoutes(app);
  registerWorkflowVersionRoutes(app);
  toHonoRoute(app, listWorkflowsOperation);
  toHonoRoute(app, listSchedulesOperation);
  toHonoRoute(app, createScheduleOperation);
  toHonoRoute(app, updateScheduleOperation);
  toHonoRoute(app, deleteScheduleOperation);
  toHonoRoute(app, createWorkflowOperation);
  toHonoRoute(app, validateWorkflowOperation);
  toHonoRoute(app, getWorkflowOperation);

  toHonoRoute(app, getWorkflowInputSchemaOperation);

  toHonoRoute(app, updateWorkflowOperation);
  toHonoRoute(app, updateWorkflowMetadataOperation);
  toHonoRoute(app, deleteWorkflowOperation);
}
