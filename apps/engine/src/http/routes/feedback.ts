import type { OpenAPIHono } from "@hono/zod-openapi";
import { submitFeedbackOperation } from "../../api/operations/feedback.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import type { AppEnv } from "../openapi.ts";

export function registerFeedbackRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, submitFeedbackOperation);
}
