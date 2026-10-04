import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  ConnectorCallRequestSchema,
  ConnectorCallResponseSchema,
} from "../../../api/connector-schemas.ts";
import { type CallConnectorMethod, callConnector } from "../../../connectors/index.ts";
import { NotFoundError, UnprocessableEntityError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const callRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/call",
  tags: ["connectors"],
  summary: "Invoke an HTTP/GraphQL endpoint against a persisted connector",
  description:
    "Programmatic surface for ad-hoc connector invocation. Mirrors the call_connector conversation tool: applies the saved credential, audits as connector.invoked, and returns {status, headers, body, latency_ms} with truncation flags for response bodies > 8KB. Driver coverage at this surface is HTTP and GraphQL only — a `postgres` or `s3` connector returns a 422 envelope pointing at workflow-step authoring, and an `mcp` connector one naming the request step's `mcp` sub-block, because an MCP call names a tool and its arguments rather than a method and a path.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ConnectorCallRequestSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConnectorCallResponseSchema } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description:
        "Unprocessable entity — `details.error_code` says why: `connector_disabled` (the connector is switched off; nothing was sent), `credential_required`, `driver_not_supported_for_call_connector`, `invalid_input` or `call_failed`.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerCallRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(callRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const result = await callConnector({
      db,
      tenant_id: principal.tenant_id,
      actor_id: principal.id,
      connector_id: id,
      method: (body.method ?? "GET") as CallConnectorMethod,
      path: body.path ?? "",
      ...(body.query ? { query: body.query } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}),
    });

    if (result.kind === "ok") {
      return c.json(
        {
          status: result.status,
          headers: result.headers,
          body: result.body,
          latency_ms: result.latency_ms,
          truncated: result.truncated,
          body_byte_count: result.body_byte_count,
          health: result.health,
          metadata: result.metadata,
          ...(result.raw_ref ? { raw_ref: result.raw_ref } : {}),
          ...(result.health_suggestion ? { health_suggestion: result.health_suggestion } : {}),
          ...(result.next_best_actions ? { next_best_actions: result.next_best_actions } : {}),
        },
        200,
      );
    }

    switch (result.error_code) {
      case "connector_not_found":
        throw new NotFoundError("connector");
      case "connector_disabled":
      case "credential_required":
      case "driver_not_supported_for_call_connector":
      case "invalid_input":
      case "call_failed": {
        const details: Record<string, unknown> = {
          error_code: result.error_code,
          driver: result.driver,
          latency_ms: result.latency_ms,
        };
        if (result.next_best_actions) details.next_best_actions = result.next_best_actions;
        if (result.metadata) details.metadata = result.metadata;
        throw new UnprocessableEntityError(result.message, details);
      }
    }
  });
}
