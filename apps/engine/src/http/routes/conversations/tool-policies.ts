import type { OpenAPIHono } from "@hono/zod-openapi";
import { conversationToolPolicyOperations } from "../../../api/operations/conversation-tool-policies.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { getConversation } from "../../../conversations/public/lifecycle.ts";
import * as svc from "../../../conversations/public/tool-contract.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerToolPoliciesRoutes(app: OpenAPIHono<AppEnv>): void {
  const operations = conversationToolPolicyOperations({ ...svc, getConversation });
  toHonoRoute(app, operations.get);
  toHonoRoute(app, operations.put);
}
