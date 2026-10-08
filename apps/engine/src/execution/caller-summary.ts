import { z } from "@hono/zod-openapi";
import type { executions } from "../db/schema/index.ts";

export const CALLER_VERIFICATION_METHODS = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
] as const;

export const ExecutionCallerSchema = z
  .object({
    kind: z.enum(["user", "system_account", "engine"]),
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
  | "caller_context"
  | "authorization_context"
  | "request_source"
  | "authority_root_execution_id"
>;

export function describeExecutionCaller(row: CallerRow): ExecutionCaller {
  const caller = row.caller_context;
  const origin = row.authority_root_execution_id;
  return {
    kind: caller?.principalKind ?? "engine",
    principal_id: caller?.principalId ?? null,
    provider: caller?.provider ?? null,
    product_id: caller?.productId ?? null,
    verified_by: row.authorization_context?.source.kind ?? null,
    channel: row.request_source,
    origin_execution_id: origin && origin !== row.id ? origin : null,
  };
}
