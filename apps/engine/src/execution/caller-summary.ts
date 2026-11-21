import { z } from "@hono/zod-openapi";
import type { executions } from "../db/schema/index.ts";
import { ExecutionAuthorizationContextSchema } from "./authorization-context.ts";
import { CallerContextSchema } from "./caller-context.ts";
import { resolveExecutionCallerOrigin } from "./caller-origin.ts";
import { matchingWorkflowPermission } from "./workflow-permission.ts";

const CALLER_VERIFICATION_METHODS = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "task_run",
] as const;

export const ExecutionCallerSchema = z
  .object({
    kind: z.enum(["user", "system_account", "engine", "unknown"]),
    principal_id: z.string().nullable(),
    provider: z.string().nullable(),
    product_id: z.string().nullable(),
    verified_by: z.enum(CALLER_VERIFICATION_METHODS).nullable(),
    channel: z.string(),
    origin_execution_id: z.string().uuid().nullable(),
  })
  .openapi("ExecutionCaller");

export type ExecutionCaller = z.infer<typeof ExecutionCallerSchema>;

type CallerRow = Pick<
  typeof executions.$inferSelect,
  | "id"
  | "tenant_id"
  | "workflow_id"
  | "caller_origin"
  | "caller_context"
  | "authorization_context"
  | "request_source"
  | "authority_root_execution_id"
>;

export function describeExecutionCaller(row: CallerRow): ExecutionCaller {
  const provenance = resolveExecutionCallerOrigin(
    row.tenant_id,
    row.caller_context,
    row.caller_origin,
  );
  const caller = provenance === "principal" ? CallerContextSchema.parse(row.caller_context) : null;
  const authorization = ExecutionAuthorizationContextSchema.safeParse(row.authorization_context);
  const verifiedAuthorization =
    caller &&
    authorization.success &&
    (!authorization.data.workflow_permission ||
      matchingWorkflowPermission(authorization.data.workflow_permission, caller, row.workflow_id));
  const origin = row.authority_root_execution_id;
  return {
    kind: caller?.principalKind ?? (provenance === "trusted_system" ? "engine" : "unknown"),
    principal_id: caller?.principalId ?? null,
    provider: caller?.provider ?? null,
    product_id: caller?.productId ?? null,
    verified_by:
      verifiedAuthorization &&
      authorization.success &&
      authorization.data.source.kind !== "device_runner"
        ? authorization.data.source.kind
        : null,
    channel: row.request_source,
    origin_execution_id: origin && origin !== row.id ? origin : null,
  };
}
