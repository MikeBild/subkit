import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/index.ts";
import {
  type ConfirmLocalCommandResult,
  confirmLocalCommand,
  LocalCommandConfirmError,
} from "../../connectors/index.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

const ConfirmLocalCommandBodySchema = z
  .object({
    command_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "The command_hash of the command shown to the person; a command changed since then is refused",
      ),
  })
  .openapi("ConfirmLocalCommandBody");

const LocalCommandSchema = z
  .object({
    command_line: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env_names: z.array(z.string()),
    env_secret_names: z.array(z.string()),
    cwd: z.string().nullable(),
    command_hash: z.string(),
  })
  .openapi("LocalCommand");

const ConfirmLocalCommandResponseSchema = z
  .object({
    connector_id: z.string().uuid(),
    command: LocalCommandSchema,
    confirmed_by: z.string(),
    confirmed_at: z.string(),
    already_confirmed: z.boolean(),
  })
  .openapi("ConfirmLocalCommandResponse");

interface ConfirmLocalCommandInput {
  readonly id: string;
  readonly command_hash: string;
}

function confirmRejection(error: LocalCommandConfirmError): Rejection {
  const details = error.command ? { command: error.command } : undefined;
  if (error.code === "not_found") return reject.notFound("connector");
  if (error.code === "command_changed")
    return reject.conflict(error.message, details, "mcp_local_command_changed");
  if (error.code === "self_confirmation")
    return reject.status(403, "mcp_local_command_self_confirmation", error.message, details);
  return reject.unprocessable(error.message, details, "mcp_not_stdio");
}

export const confirmLocalCommandOperation = defineOperation<
  ConfirmLocalCommandInput,
  ConfirmLocalCommandResult
>({
  id: "connector.confirm_local_command",
  summary: "Confirm the local command of a stdio MCP connector so the engine may start it",
  permission: "connector:confirm_local_command",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_LOCAL_COMMAND_CONFIRMED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      return await confirmLocalCommand(
        scope.db,
        scope.tenant_id,
        input.id,
        { id: principal.id, kind: principal.kind },
        input.command_hash,
      );
    } catch (error) {
      if (error instanceof LocalCommandConfirmError) return confirmRejection(error);
      throw error;
    }
  },
  http: {
    method: "post",
    path: "/v1/connectors/{id}/mcp/confirm-command",
    tags: ["connectors"],
    params: IdParam,
    body: ConfirmLocalCommandBodySchema,
    response: ConfirmLocalCommandResponseSchema,
    success: [{ status: 200, description: "Confirmed, or already confirmed" }],
    errors: {
      403: "The person who entered or changed the command cannot confirm it",
      404: "Not found",
      409: "The command changed after it was shown",
      422: "The connector starts no local command",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      command_hash: (json as z.infer<typeof ConfirmLocalCommandBodySchema>).command_hash,
    }),
    toBody: (result) => result,
  },
});
