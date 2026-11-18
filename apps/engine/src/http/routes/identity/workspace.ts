import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  updateOwnProfileOperation,
  updateWorkspaceOperation,
} from "../../../api/operations/identity-workspace.ts";
import { setWorkspaceAiAccessOperation } from "../../../api/operations/workspace-ai-access.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerWorkspaceRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, updateOwnProfileOperation);
  toHonoRoute(app, updateWorkspaceOperation);
  toHonoRoute(app, setWorkspaceAiAccessOperation);
}
