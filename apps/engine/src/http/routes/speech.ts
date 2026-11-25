import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { speechOperations } from "../../api/operations/speech.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSpeechRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, speechOperations.status);
  toHonoRoute(app, speechOperations.prepare);
  toHonoRoute(app, speechOperations.transcribe);
}
