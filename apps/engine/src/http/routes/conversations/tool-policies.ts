import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  canSetConversationToolPolicy,
  eligibleNoConfirmTools,
  getConversation,
  getToolPolicies,
  setToolPolicies,
} from "../../../conversations/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth, requireSignedInPerson } from "../../middleware/auth.ts";
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
    422: {
      description: "The requested confirmation mode is not permitted for this tool",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerToolPoliciesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(toolPoliciesGetRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const detail = await getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    const policies = await getToolPolicies(db, principal.tenant_id, id);
    return c.json({ policies, eligible_no_confirm_tools: eligibleNoConfirmTools() }, 200);
  });

  app.openapi(toolPoliciesPutRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await getConversation(principal.tenant_id, id, db);
    if (!detail) throw new NotFoundError("conversation");
    for (const [toolName, mode] of Object.entries(body.policies)) {
      if (!canSetConversationToolPolicy(toolName, mode)) {
        throw new HttpError(
          422,
          "tool_policy_mode_not_allowed",
          "this confirmation mode is not allowed for the tool in a conversation",
        );
      }
    }
    if (Object.values(body.policies).some((mode) => mode === "no_confirm")) {
      requireSignedInPerson(
        principal,
        "a signed-in browser session is required to skip confirmation in a conversation",
      );
    }
    await setToolPolicies(db, principal.tenant_id, id, body.policies, {
      actor_type: principal.kind,
      actor_id: principal.id,
      request_source: "api",
    });
    const policies = await getToolPolicies(db, principal.tenant_id, id);
    return c.json({ policies, eligible_no_confirm_tools: eligibleNoConfirmTools() }, 200);
  });
}
