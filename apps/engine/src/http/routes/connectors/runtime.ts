// A connector's runtime and its operator trust settings:
//   GET /v1/connectors/{id}/runtime                  — `connector:read`
//   PUT /v1/connectors/{id}/mcp/tool-confirmation    — `connector:write`
//
// The runtime is read-only and derived: the newest successful and failed call
// from `audit_log`, and an mcp connector's negotiated session row. It is a
// separate resource rather than more fields on `Connector` because it is a
// read over the audit trail, not state of the connector row — a list of
// connectors must not pay for it.
//
// The tool-confirmation route is the ONE writer of
// `config.mcp.tools_without_confirmation` (connectors/mcp-tool-trust.ts). Its
// RBAC gate lives in ./index.ts with every other per-path gate.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import { PREVIEW_CLASSIFICATIONS } from "../../../execution/index.ts";
import { NotFoundError, UnprocessableEntityError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const ConnectorRuntimeSchema = z
  .object({
    last_success_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ description: "When the newest successful call was recorded." }),
    last_failure: z
      .object({
        at: z.string().datetime(),
        code: z.string().openapi({
          description:
            "Low-cardinality failure code: the status class (`4xx_auth`, `5xx`, …), `network_error` for a call with no status, `remote_error` for an MCP tool that answered with an error.",
        }),
        // Inline, not the named `FailureCauseClass`: the engine's own
        // classification of the failure, never the remote's text.
        cause_class: z.enum(PREVIEW_CLASSIFICATIONS),
      })
      .nullable(),
    recorded: z.boolean().openapi({
      description:
        "Whether this connector's driver records every call in the audit log. False means the absence of calls says nothing.",
    }),
    mcp_session: z
      .object({
        protocol_version: z.string().nullable(),
        capabilities: z.array(z.string()),
        last_handshake_at: z.string().datetime().nullable(),
        consecutive_failures: z.number().int().nonnegative(),
        backoff_until: z.string().datetime().nullable(),
      })
      .nullable()
      .openapi({
        description: "The negotiated MCP session; null for other drivers or before a handshake.",
      }),
  })
  .openapi("ConnectorRuntime");

const runtimeRoute = createRoute({
  method: "get",
  path: "/v1/connectors/{id}/runtime",
  tags: ["connectors"],
  summary: "A connector's newest successful and failed call, and its MCP session",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ConnectorRuntimeSchema } },
    },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const ToolConfirmationBody = z
  .object({
    tool: z.string().min(1).max(256).openapi({
      description: "The remote tool's own name, as the server's tools/list reports it.",
    }),
    confirm: z.boolean().openapi({
      description:
        "true: ask before every call (the default). false: this tool runs without asking.",
    }),
  })
  .strict()
  .openapi("ConnectorMcpToolConfirmationRequest");

const ToolConfirmationResponse = z
  .object({
    tool: z.string(),
    confirm: z.boolean(),
    tools_without_confirmation: z.array(z.string()),
  })
  .openapi("ConnectorMcpToolConfirmation");

const toolConfirmationRoute = createRoute({
  method: "put",
  path: "/v1/connectors/{id}/mcp/tool-confirmation",
  tags: ["connectors"],
  summary: "Decide whether one remote tool of an mcp connector asks before it runs",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ToolConfirmationBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ToolConfirmationResponse } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Not an mcp connector",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerConnectorRuntimeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(runtimeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const runtime = await connectorSvc.readConnectorRuntime(db, principal.tenant_id, connector);
    return c.json(runtime, 200);
  });

  app.openapi(toolConfirmationRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    if (connector.driver !== "mcp") {
      throw new UnprocessableEntityError("only an mcp connector has remote tools to confirm");
    }
    const result = await connectorSvc.setMcpToolConfirmation(db, {
      tenant_id: principal.tenant_id,
      connector_id: id,
      tool: body.tool,
      confirm: body.confirm,
      actor_id: principal.id,
    });
    if (!result) throw new NotFoundError("connector");
    return c.json(result, 200);
  });
}
