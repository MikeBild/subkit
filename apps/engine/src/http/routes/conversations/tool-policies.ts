// Per-conversation tool policy overrides:
//   GET /v1/conversations/{id}/tool-policies
//   PUT /v1/conversations/{id}/tool-policies

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as svc from "../../../conversations/service.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ToolPoliciesResponse, ToolPoliciesSchema } from "./schemas.ts";

const toolPoliciesGetRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{id}/tool-policies",
  tags: ["conversations"],
  summary: "Read per-tool execution-mode overrides for this conversation",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ToolPoliciesResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const toolPoliciesPutRoute = createRoute({
  method: "put",
  path: "/v1/conversations/{id}/tool-policies",
  tags: ["conversations"],
  summary:
    "Set per-tool execution-mode overrides. Pass `null` for a tool to clear its override and fall back to the default policy.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ToolPoliciesSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ToolPoliciesResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerToolPoliciesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(toolPoliciesGetRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    // Confirm the conversation belongs to the tenant before reading.
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    const { getToolPolicies } = await import("../../../conversations/tool-policies.ts");
    const policies = await getToolPolicies(db, id);
    return c.json({ policies }, 200);
  });

  app.openapi(toolPoliciesPutRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await svc.getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    const { setToolPolicy, getToolPolicies } = await import(
      "../../../conversations/tool-policies.ts"
    );
    for (const [toolName, mode] of Object.entries(body.policies)) {
      await setToolPolicy(db, id, toolName, mode);
    }
    const policies = await getToolPolicies(db, id);
    return c.json({ policies }, 200);
  });
}
