import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  activateRuntimeRevisionOperation,
  createRuntimeSecretOperation,
  getRuntimeActivationOperation,
  getRuntimeRevisionOperation,
  getRuntimeSettingsOperation,
  listRuntimeRevisionsOperation,
  listRuntimeSecretsOperation,
  patchRuntimeSettingsOperation,
  revokeRuntimeSecretOperation,
} from "../../api/operations/runtime-config.ts";
import type { AppEnv } from "../openapi.ts";

export function registerRuntimeConfigRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, getRuntimeSettingsOperation);
  toHonoRoute(app, patchRuntimeSettingsOperation);
  toHonoRoute(app, listRuntimeRevisionsOperation);
  toHonoRoute(app, getRuntimeRevisionOperation);
  toHonoRoute(app, activateRuntimeRevisionOperation);
  toHonoRoute(app, getRuntimeActivationOperation);
  toHonoRoute(app, listRuntimeSecretsOperation);
  toHonoRoute(app, createRuntimeSecretOperation);
  toHonoRoute(app, revokeRuntimeSecretOperation);
}
