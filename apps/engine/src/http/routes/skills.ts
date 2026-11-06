import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  activateSkillOperation,
  archiveSkillOperation,
  createSkillOperation,
  deleteSkillOperation,
  getSkillHistoryEntryOperation,
  getSkillOperation,
  listSkillHistoryOperation,
  listSkillsOperation,
  restoreSkillOperation,
  updateSkillOperation,
} from "../../api/operations/skills.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSkillRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listSkillsOperation);
  toHonoRoute(app, createSkillOperation);
  toHonoRoute(app, getSkillOperation);
  toHonoRoute(app, updateSkillOperation);
  toHonoRoute(app, deleteSkillOperation);
  toHonoRoute(app, activateSkillOperation);
  toHonoRoute(app, archiveSkillOperation);
  toHonoRoute(app, listSkillHistoryOperation);
  toHonoRoute(app, getSkillHistoryEntryOperation);
  toHonoRoute(app, restoreSkillOperation);
}
