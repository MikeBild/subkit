import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { setMcpToolConfirmation } from "../../connectors/mcp-tool-trust.ts";
import { readConnectorRuntime } from "../../connectors/runtime.ts";
import { getConnector } from "../../connectors/service.ts";
import { PREVIEW_CLASSIFICATIONS } from "../../execution/classify.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

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
        cause_class: z.enum(PREVIEW_CLASSIFICATIONS),
      })
      .nullable()
      .openapi({
        description:
          "The newest failed call. Null when that call was rejected for its credential before the newest stored credential (a sign-in or a replaced key): the new credential resolved it. A token refresh resolves nothing.",
      }),
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

type ToolConfirmation = z.infer<typeof ToolConfirmationBody>;
type ConnectorRuntime = Awaited<ReturnType<typeof readConnectorRuntime>>;
type ToolConfirmationResult = NonNullable<Awaited<ReturnType<typeof setMcpToolConfirmation>>>;

const notMcp: Rejection = {
  rejected: true,
  status: 422,
  code: "unprocessable_entity",
  message: "only an mcp connector has remote tools to confirm",
};

export const connectorRuntimeOperation = defineOperation<string, ConnectorRuntime>({
  id: "connector.runtime",
  summary: "A connector's newest successful and failed call, and its MCP session",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "read",
  async handler(scope, id) {
    const connector = await getConnector(scope.tenant_id, id, scope.db);
    if (!connector) return reject.notFound("connector");
    return readConnectorRuntime(scope.db, scope.tenant_id, connector);
  },
  http: {
    method: "get",
    path: "/v1/connectors/{id}/runtime",
    tags: ["connectors"],
    params: IdParam,
    response: ConnectorRuntimeSchema,
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: (runtime) => runtime,
  },
});

interface ToolConfirmationInput {
  readonly id: string;
  readonly body: ToolConfirmation;
}

export const connectorToolConfirmationOperation = defineOperation<
  ToolConfirmationInput,
  ToolConfirmationResult
>({
  id: "connector.mcp_tool_confirmation",
  summary: "Decide whether one remote tool of an mcp connector asks before it runs",
  permission: "connector:write",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const connector = await getConnector(scope.tenant_id, id, scope.db);
    if (!connector) return reject.notFound("connector");
    if (connector.driver !== "mcp") return notMcp;
    const result = await setMcpToolConfirmation(scope.db, {
      tenant_id: scope.tenant_id,
      connector_id: id,
      tool: body.tool,
      confirm: body.confirm,
      actor_id: principal.id,
      actor: actorOf(principal),
    });
    return result ?? reject.notFound("connector");
  },
  http: {
    method: "put",
    path: "/v1/connectors/{id}/mcp/tool-confirmation",
    tags: ["connectors"],
    params: IdParam,
    body: ToolConfirmationBody,
    response: ToolConfirmationResponse,
    errors: {
      400: "Bad request",
      403: "Forbidden",
      404: "Not found",
      422: "Not an mcp connector",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      body: json as ToolConfirmation,
    }),
    toBody: (result) => result,
  },
});
