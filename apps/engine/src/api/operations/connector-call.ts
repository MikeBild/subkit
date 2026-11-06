import type { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  type CallConnectorMethod,
  callConnector,
} from "../../connectors/services/call-connector.ts";
import { IdParam } from "../common-schemas.ts";
import { ConnectorCallRequestSchema, ConnectorCallResponseSchema } from "../connector-schemas.ts";
import { defineOperation, reject } from "./index.ts";

type CallInput = { readonly id: string } & z.infer<typeof ConnectorCallRequestSchema>;
type CallBody = z.infer<typeof ConnectorCallResponseSchema>;

export const callConnectorOperation = defineOperation<CallInput, CallBody>({
  id: "connector.call",
  summary: "Invoke an HTTP/GraphQL endpoint against a persisted connector",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_INVOKED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const result = await callConnector({
      db: scope.db,
      tenant_id: scope.tenant_id,
      actor_id: principal.id,
      actor_type: principal.kind,
      connector_id: body.id,
      method: (body.method ?? "GET") as CallConnectorMethod,
      path: body.path ?? "",
      ...(body.query ? { query: body.query } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}),
    });
    if (result.kind === "ok") {
      return {
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
      };
    }
    if (result.error_code === "connector_not_found") return reject.notFound("connector");
    const details: Record<string, unknown> = {
      error_code: result.error_code,
      driver: result.driver,
      latency_ms: result.latency_ms,
    };
    if (result.next_best_actions) details.next_best_actions = result.next_best_actions;
    if (result.metadata) details.metadata = result.metadata;
    return reject.unprocessable(result.message, details, "unprocessable_entity");
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/call",
    tags: ["connectors"],
    description:
      "Programmatic surface for ad-hoc connector invocation. Mirrors the call_connector conversation tool: applies the saved credential, audits as connector.invoked, and returns {status, headers, body, latency_ms} with truncation flags for response bodies > 8KB. Driver coverage at this surface is HTTP and GraphQL only — a `postgres` or `s3` connector returns a 422 envelope pointing at workflow-step authoring, and an `mcp` connector one naming the request step's `mcp` sub-block, because an MCP call names a tool and its arguments rather than a method and a path.",
    params: IdParam,
    body: ConnectorCallRequestSchema,
    response: ConnectorCallResponseSchema,
    errors: {
      403: "Forbidden",
      404: "Not found",
      422: "Unprocessable entity — `details.error_code` says why: `connector_disabled` (the connector is switched off; nothing was sent), `credential_required`, `driver_not_supported_for_call_connector`, `invalid_input` or `call_failed`.",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      ...(json as z.infer<typeof ConnectorCallRequestSchema>),
    }),
    toBody: (result) => result,
  },
});
