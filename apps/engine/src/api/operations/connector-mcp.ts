import { z } from "@hono/zod-openapi";
import { classifyMcpToolSideEffect } from "@shared/side-effects.ts";
import { connectServerById } from "../../mcp/client/pool.ts";
import { getMcpConnector, MCP_CREDENTIAL_ENVIRONMENT } from "../../mcp/client/registry.ts";
import { mcpToolDescriptorPin } from "../../workflows/mcp-boundary.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

export const MCP_ERRORS = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  422: "Invalid",
} as const;

const InspectResponse = z
  .object({
    connector_id: z.string(),
    slug: z.string(),
    tools: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()).nullable(),
        claims: z.enum(["read", "write"]).optional(),
        boundary_descriptor: z
          .object({
            input_schema_digest: z.string(),
            annotations: z
              .object({
                readOnlyHint: z.boolean().optional(),
                destructiveHint: z.boolean().optional(),
                idempotentHint: z.boolean().optional(),
                openWorldHint: z.boolean().optional(),
              })
              .strict(),
          })
          .openapi({
            description:
              "The exact value for `mcp.boundary.descriptor` on a step that calls this tool.",
          }),
      }),
    ),
    capabilities: z
      .object({ tools: z.boolean(), resources: z.boolean(), prompts: z.boolean() })
      .nullable(),
    instructions: z.string().nullable(),
    server_version: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("ConnectorMcpInspectResponse");

export function boundaryDescriptorOf(tool: Parameters<typeof mcpToolDescriptorPin>[0]) {
  const pin = mcpToolDescriptorPin(tool);
  return { input_schema_digest: pin.input_schema_digest, annotations: pin.annotations };
}

export const inspectMcpConnectorOperation = defineOperation<
  { id: string },
  z.infer<typeof InspectResponse>
>({
  id: "connector.mcp_inspect",
  summary: "Force one handshake against an mcp connector and report what it serves",
  permission: "connector:test",
  resource: { type: "connector", param: "id" },
  effect: "read",
  handler: async (scope, { id }) => {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const connector = await getMcpConnector(scope.db, scope.tenant_id, id);
    if (!connector) return reject.notFound("mcp connector");
    const outcome = await connectServerById(scope.db, scope.tenant_id, id, {
      environment: MCP_CREDENTIAL_ENVIRONMENT,
      requestSource: scope.request_source ?? "api",
      actor_id: principal.id,
      actor_type: principal.kind,
    });
    if (!outcome.ok) {
      if (outcome.reason === "disabled") {
        return reject.unprocessable(
          "this mcp connector is disabled — enable it before inspecting",
          undefined,
          "unprocessable_entity",
        );
      }
      return reject.status(
        502,
        "mcp_handshake_failed",
        outcome.detail ?? "the external MCP server refused the handshake",
      );
    }
    const set = outcome.tools;
    return {
      connector_id: id,
      slug: set.slug,
      tools: set.tools.map((t) => ({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
        input_schema: t.inputSchema ?? null,
        ...(t.annotations ? { claims: classifyMcpToolSideEffect(t.annotations) } : {}),
        boundary_descriptor: boundaryDescriptorOf(t),
      })),
      capabilities: set.capabilities,
      instructions: set.instructions,
      server_version: set.server_version,
    };
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/mcp/inspect",
    tags: ["connectors"],
    params: IdParam,
    response: InspectResponse,
    errors: { ...MCP_ERRORS, 502: "Handshake failed" },
    toInput: ({ param }) => param as { id: string },
    toBody: (result) => result,
  },
});
