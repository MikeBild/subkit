// Per-conversation tool policy overrides:
//   GET /v1/conversations/{id}/tool-policies
//   PUT /v1/conversations/{id}/tool-policies

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait, ToolPolicyChangedMetadataSchema } from "../../../audit/index.ts";
import * as svc from "../../../conversations/index.ts";
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
    const policies = await getToolPolicies(db, principal.tenant_id, id);
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
    // Snapshot prior policy state so each audit row records both
    // the relaxation direction and the destination — investigators
    // querying "who relaxed gating on tool X" need both ends.
    const prior = await getToolPolicies(db, principal.tenant_id, id);
    for (const [toolName, mode] of Object.entries(body.policies)) {
      await setToolPolicy(db, principal.tenant_id, id, toolName, mode);
      // Tool-policy changes are governance decisions: who relaxed
      // gating on which tool, when, for which conversation. Audit
      // every change so compliance can scan `audit_log` for any
      // `tool_policy.changed` entry without scraping HTTP logs.
      // Parse through ToolPolicyChangedMetadataSchema to lock the
      // shape downstream BI / SIEM consumers will see. A future
      // typo (`mode_prior`, "API" vs "api", etc.) fails at request
      // time instead of corrupting the audit log.
      const metadata = ToolPolicyChangedMetadataSchema.parse({
        tool: toolName,
        mode: mode ?? null,
        prior_mode: prior[toolName] ?? null,
        request_source: "api",
      });
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.TOOL_POLICY_CHANGED,
          resource_type: "conversation",
          resource_id: id,
          result: "success",
          metadata,
        },
        db,
      );
    }
    const policies = await getToolPolicies(db, principal.tenant_id, id);
    return c.json({ policies }, 200);
  });
}
