import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { listTaskScheduleOccurrencesOperation } from "../../api/operations/schedule-occurrences.ts";
import {
  grantTaskAuthorityOperation,
  listTaskGrantsOperation,
  previewTaskGrantOperation,
  revokeTaskAuthorityOperation,
} from "../../api/operations/task-grants.ts";
import {
  abortTaskRunOperation,
  completeTaskRunOperation,
  continueTaskRunInNewConversationOperation,
  getTaskRunOperation,
  listTaskRunsOperation,
  rejectTaskRunResultOperation,
  startTaskRunOperation,
} from "../../api/operations/task-runs.ts";
import { getTaskUsageOperation } from "../../api/operations/task-usage.ts";
import {
  createTaskOperation,
  deleteTaskOperation,
  getTaskOperation,
  listTasksOperation,
  pauseTaskOperation,
  resumeTaskOperation,
  updateTaskOperation,
} from "../../api/operations/tasks.ts";
import type { AppEnv } from "../openapi.ts";

export function registerTaskRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listTasksOperation);
  toHonoRoute(app, createTaskOperation);
  toHonoRoute(app, getTaskOperation);
  toHonoRoute(app, updateTaskOperation);
  toHonoRoute(app, deleteTaskOperation);
  toHonoRoute(app, pauseTaskOperation);
  toHonoRoute(app, resumeTaskOperation);
  toHonoRoute(app, getTaskUsageOperation);
  toHonoRoute(app, listTaskScheduleOccurrencesOperation);
  toHonoRoute(app, startTaskRunOperation);
  toHonoRoute(app, listTaskRunsOperation);
  toHonoRoute(app, getTaskRunOperation);
  toHonoRoute(app, abortTaskRunOperation);
  toHonoRoute(app, completeTaskRunOperation);
  toHonoRoute(app, rejectTaskRunResultOperation);
  toHonoRoute(app, continueTaskRunInNewConversationOperation);
  toHonoRoute(app, previewTaskGrantOperation);
  toHonoRoute(app, listTaskGrantsOperation);
  toHonoRoute(app, grantTaskAuthorityOperation);
  toHonoRoute(app, revokeTaskAuthorityOperation);
}
