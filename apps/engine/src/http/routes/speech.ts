import type { OpenAPIHono } from "@hono/zod-openapi";
import { speechOperations, toHonoRoute } from "../../api/index.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSpeechRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, speechOperations.status);
  toHonoRoute(app, speechOperations.prepare);
  toHonoRoute(app, speechOperations.transcribe);
}
