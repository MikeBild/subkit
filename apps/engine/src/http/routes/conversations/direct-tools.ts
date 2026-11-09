import type { OpenAPIHono } from "@hono/zod-openapi";
import { conversationDirectToolOperations } from "../../../api/operations/conversation-direct-tools.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { PendingElicitationBlockedError } from "../../../conversations/public/elicitation.ts";
import * as svc from "../../../conversations/public/tool-contract.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerDirectToolRoutes(app: OpenAPIHono<AppEnv>): void {
  const operations = conversationDirectToolOperations({ ...svc, PendingElicitationBlockedError });
  toHonoRoute(app, operations.preview);
  toHonoRoute(app, operations.probe);
  toHonoRoute(app, operations.draftPatch);
  toHonoRoute(app, operations.snapshots);
  toHonoRoute(app, operations.restore);
}
