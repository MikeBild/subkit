import { z } from "@hono/zod-openapi";
import { resolveWorkflowInputSchema } from "../../workflows/invocation.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const InputSchemaResponse = z
  .object({
    source: z.enum(["declared", "synthesized", "none"]),
    schema: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi("WorkflowInputSchemaResponse");

type InputSchemaResult = ReturnType<typeof resolveWorkflowInputSchema>;

export const getWorkflowInputSchemaOperation = defineOperation({
  id: "workflow.input_schema",
  summary: "Get a workflow's input schema (declared or synthesized)",
  permission: "workflow:read",
  alternatePermissions: ["workflow:run"],
  resource: { type: "workflow", param: "id" },
  effect: "read",
  handler: async (
    scope,
    input: { id: string },
  ): Promise<InputSchemaResult | ReturnType<typeof reject.notFound>> => {
    const workflow = await getWorkflow(scope.tenant_id, input.id, scope.db);
    if (!workflow) return reject.notFound("workflow");
    return resolveWorkflowInputSchema(workflow.definition);
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/input-schema",
    tags: ["workflows"],
    description:
      "Returns the workflow's declared `input_schema` when present, otherwise synthesizes one from `$input.X` placeholder and JSONata references discovered in the steps. Mirrors the convention used by the MCP tool surface so non-MCP HTTP callers can discover the input shape without round-tripping through MCP.",
    params: IdParam,
    response: InputSchemaResponse,
    errors: { 403: "Forbidden", 404: "Not found" },
    toInput: (request) => request.param as { id: string },
    toBody: (result) => result,
  },
});
